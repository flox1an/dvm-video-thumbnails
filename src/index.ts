#!/usr/bin/env node
import dayjs from "dayjs";
import { NostrEvent, Subscription, Filter, finalizeEvent, nip04 } from "nostr-tools";
import { BLOSSOM_UPLOAD_SERVER, NOSTR_PRIVATE_KEY, NOSTR_RELAYS } from "./env.js";
import { getInput, getInputParam, getInputParams, getInputTag, getOutputType, getRelays } from "./helpers/dvm.js";
import { unique } from "./helpers/array.js";
import { pool } from "./pool.js";
import { logger } from "./debug.js";
import { DVM_VIDEO_THUMB_REQUEST_KIND, DVM_VIDEO_THUMB_RESULT_KIND } from "./const.js";
import { extractThumbnails, extractVideoMetadata } from "./helpers/ffmpeg.js";
import { uploadFile } from "./helpers/blossom.js";
import { rmSync } from "fs";

type JobContext = {
  request: NostrEvent;
  url: string;
  thumbnailCount: number;
  imageFormat: "jpg" | "png";
  uploadServer: string;
};

async function shouldAcceptJob(request: NostrEvent): Promise<JobContext> {
  //const decryptedContent = await nip04.decrypt(NOSTR_PRIVATE_KEY, request.pubkey, request.content);
  //encryptedTags = JSON.parse(decryptedContent);

  const input = getInput(request);
  const output = getOutputType(request);

  const authTokens = unique(getInputParams(request, "authToken"));
  const thumbnailCount = parseInt(getInputParam(request, "thumbnailCount", "3"), 10);
  const imageFormat = getInputParam(request, "imageFormat", "jpg");
  const uploadServer = getInputParam(request, "uploadServer", BLOSSOM_UPLOAD_SERVER);

  // if (output !== "text/plain") throw new Error(`Unsupported output type ${output}`);

  if (thumbnailCount < 1 || thumbnailCount > 10) {
    throw new Error(`Thumbnail count has to be between 1 and 10`);
  }

  // uniq auth token either 0 or len>=thumbnailCount
  if (authTokens.length > 0 && authTokens.length <= thumbnailCount) {
    throw new Error(`Not enough auth tokens ${authTokens.length} for ${thumbnailCount} thumbnail uploads.`);
  }

  // TODO check that auth tokens are not expired

  // TODO add sanity checks for URL
  if (
    !uploadServer.match(
      /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/,
    )
  ) {
    throw new Error(`Upload server is not a valid url.`);
  }

  if (imageFormat != "jpg" && imageFormat != "png") {
    throw new Error(`Unsupported image format ${imageFormat}`);
  }

  if (input.type === "url") {
    return { url: input.value, request, thumbnailCount, imageFormat, uploadServer };
  } else throw new Error(`Unknown input type ${input.type}`);
}

async function retreiveMetaData(url: string): Promise<string[][]> {
  const resultTags: string[][] = [];

  const metaData = await extractVideoMetadata(url);

  const duration = metaData.format.duration.split(".")[0];
  const size = metaData.format.size;
  const videoStreamIndex = metaData.streams.findIndex((ms) => (ms.codec_type = "video"));
  const width = metaData.streams[videoStreamIndex].width;
  const height = metaData.streams[videoStreamIndex].height;

  if (width && height) {
    resultTags.push(["dim", `${width}x${height}`]);
  }
  if (duration) {
    resultTags.push(["duration", duration]);
  }
  if (size) {
    resultTags.push(["size", size]);
  }
  logger(`Video duration: ${duration}s, size: ${size}, dimensions: ${width}x${height}`);

  return resultTags;
}

async function doWork(context: JobContext) {
  logger(`Starting work for ${context.request.id}`);
  const startTime = dayjs().unix();

  logger(`creating thumb for URL ${context.url}`);

  const resultTags = await retreiveMetaData(context.url);

  const thumbnailContent = await extractThumbnails(context.url, context.thumbnailCount, context.imageFormat);

  for (const tp of thumbnailContent.thumbnailPaths) {
    const blob = await uploadFile(tp, context.uploadServer); // todo use user specfic auth Tokens
    logger(`Uploaaded thumbnail file: ${blob.url}`);
    resultTags.push(["thumb", blob.url]);
    resultTags.push(["x", blob.sha256]);
  }

  //nip04.encrypt(NOSTR_PRIVATE_KEY, p, JSON.stringify())
  const result = finalizeEvent(
    {
      kind: DVM_VIDEO_THUMB_RESULT_KIND,
      tags: [
        ["request", JSON.stringify(context.request)],
        ["e", context.request.id],
        ["p", context.request.pubkey],
        getInputTag(context.request),
        ...resultTags,
      ],
      content: "", //  JSON.stringify(metaData),
      created_at: dayjs().unix(),
    },
    NOSTR_PRIVATE_KEY,
  );

  rmSync(thumbnailContent.tempDir, { recursive: true }); // TODO also remove this when an error occurs

  const endTime = dayjs().unix();

  // TODO add DVM error events for exeptions

  logger(`${`Finished work for ${context.request.id} in ` + (endTime - startTime)} seconds`);
  await Promise.all(
    pool.publish(unique([...getRelays(context.request), ...NOSTR_RELAYS]), result).map((p) => p.catch((e) => {})),
  );
}

const seen = new Set<string>();
async function handleEvent(event: NostrEvent) {
  if (event.kind === DVM_VIDEO_THUMB_REQUEST_KIND && !seen.has(event.id)) {
    try {
      seen.add(event.id);
      const context = await shouldAcceptJob(event);
      try {
        await doWork(context);
      } catch (e) {
        if (e instanceof Error) {
          logger(`Failed to process request ${event.id} because`, e.message);
          console.log(e);
        }
      }
    } catch (e) {
      if (e instanceof Error) {
        logger(`Skipped request ${event.id} because`, e.message);
      }
    }
  }
}

const subscriptions = new Map<string, Subscription>();

const filters: Filter[] = [{ kinds: [DVM_VIDEO_THUMB_REQUEST_KIND], since: dayjs().unix() - 99000 }];
async function ensureSubscriptions() {
  for (const url of NOSTR_RELAYS) {
    const existing = subscriptions.get(url);

    if (!existing || existing.closed) {
      subscriptions.delete(url);
      const relay = await pool.ensureRelay(url);
      const sub = relay.subscribe(filters, {
        onevent: handleEvent,
        onclose: () => {
          logger("Subscription to", url, "closed");
          if (subscriptions.get(url) === sub) subscriptions.delete(url);
        },
      });

      logger("Subscribed to", url);
      subscriptions.set(url, sub);
    }
  }
}

await ensureSubscriptions();
setInterval(ensureSubscriptions, 30_000);

async function shutdown() {
  process.exit();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.once("SIGUSR2", shutdown);
