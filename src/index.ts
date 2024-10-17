#!/usr/bin/env node
import dayjs from 'dayjs';
import { NostrEvent, Filter, finalizeEvent, nip04, EventTemplate, getPublicKey } from 'nostr-tools';
import { BLOSSOM_BLOB_EXPIRATION_DAYS, BLOSSOM_UPLOAD_SERVER, NOSTR_PRIVATE_KEY, NOSTR_RELAYS } from './env.js';
import { getInput, getInputParam, getInputParams, getInputTag, getOutputType, getRelays } from './helpers/dvm.js';
import { unique } from './helpers/array.js';
import { pool } from './pool.js';
import { logger } from './debug.js';
import { DVM_VIDEO_THUMB_REQUEST_KIND, DVM_VIDEO_THUMB_RESULT_KIND } from './const.js';
import { extractThumbnails, extractVideoMetadata } from './helpers/ffmpeg.js';
import { deleteBlob, listBlobs, uploadFile } from './helpers/blossom.js';
import { rmSync } from 'fs';
import { Subscription } from 'nostr-tools/abstract-relay';

type JobContext = {
  request: NostrEvent;
  wasEncrypted: boolean;
  url: string;
  thumbnailCount: number;
  imageFormat: 'jpg' | 'png';
  // uploadServer: string;
  // authTokens: string[];
};

async function shouldAcceptJob(request: NostrEvent): Promise<JobContext> {
  const input = getInput(request);
  const output = getOutputType(request);

  // const authTokens = getInputParams(request, "authToken");
  const thumbnailCount = parseInt(getInputParam(request, 'thumbnailCount', '3'), 10);

  let imageFormat: 'jpg' | 'png';

  switch (output) {
    case 'image/jpeg':
      imageFormat = 'jpg';
      break;
    case 'image/png':
      imageFormat = 'png';
      break;
    default:
      throw new Error(`Unsupported output type ${output}`);
  }
  // const uploadServer = getInputParam(request, "uploadServer", BLOSSOM_UPLOAD_SERVER);

  if (thumbnailCount < 1 || thumbnailCount > 10) {
    throw new Error(`Thumbnail count has to be between 1 and 10`);
  }

  /*
  // uniq auth token either 0 or len>=thumbnailCount
  if ((authTokens.length > 0) && (authTokens.length < thumbnailCount)) {
    throw new Error(`Not enough auth tokens ${authTokens.length} for ${thumbnailCount} thumbnail uploads.`);
  }

  // Very that auth token have not expired
  if (
    authTokens.some((at) => {
      const authEvent = decodeBlossemAuthToken(at);
      logger('authvent', JSON.stringify(authEvent));
      const expiration = authEvent?.tags.find((t) => t[0] === "expiration")?.[1];
      return expiration && dayjs().unix() > parseInt(expiration, 10); // has a token expired?
    })
  ) {
    throw new Error(`At least one auth token is expired.`);
  }

  // TODO add sanity checks for URL
  if (
    !uploadServer.match(
      /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/,
    )
  ) {
    throw new Error(`Upload server is not a valid url.`);
  }
  */

  if (input.type === 'url') {
    return { url: input.value, request, thumbnailCount, imageFormat, wasEncrypted: false };
  } else throw new Error(`Unknown input type ${input.type}`);
}

async function retreiveMetaData(url: string): Promise<string[][]> {
  const resultTags: string[][] = [];

  const metaData = await extractVideoMetadata(url);

  const duration = metaData.format.duration.split('.')[0];
  const size = metaData.format.size;
  const videoStreamIndex = metaData.streams.findIndex(ms => (ms.codec_type = 'video'));
  const width = metaData.streams[videoStreamIndex].width;
  const height = metaData.streams[videoStreamIndex].height;

  if (width && height) {
    resultTags.push(['dim', `${width}x${height}`]);
  }
  if (duration) {
    resultTags.push(['duration', duration]);
  }
  if (size) {
    resultTags.push(['size', size]);
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

  // let tnr = 0;
  for (const tp of thumbnailContent.thumbnailPaths) {
    // const authToken = (context.authTokens.length >= tnr && context.authTokens[tnr]) || undefined;
    const blob = await uploadFile(tp, BLOSSOM_UPLOAD_SERVER);
    logger(`Uploaaded thumbnail file: ${blob.url}`);
    resultTags.push(['thumb', blob.url]);
    resultTags.push(['x', blob.sha256]);
    // tnr++;
  }

  const resultEvent = {
    kind: DVM_VIDEO_THUMB_RESULT_KIND,
    tags: [
      ['request', JSON.stringify(context.request)],
      ['e', context.request.id],
      ['p', context.request.pubkey],
      getInputTag(context.request),
      ...resultTags,
    ],
    content: '',
    created_at: dayjs().unix(),

    // TODO add expiration tag when request had an expisration tag
  };

  const event = await ensureEncrypted(resultEvent, context.request.pubkey, context.wasEncrypted);
  const result = finalizeEvent(event, NOSTR_PRIVATE_KEY);

  rmSync(thumbnailContent.tempDir, { recursive: true }); // TODO also remove this when an error occurs

  const endTime = dayjs().unix();

  // TODO add DVM error events for exeptions

  logger(`${`Finished work for ${context.request.id} in ` + (endTime - startTime)} seconds`);
  const relays = unique([...getRelays(context.request), ...NOSTR_RELAYS]).filter(r => !!r);
  logger('publishing to relays: ', relays);
  await Promise.all(
    pool.publish(relays, result).map(p => p.catch(e => {}))
  );
}

async function ensureEncrypted(event: EventTemplate, recipentPubKey: string, wasEncrypted: boolean) {
  if (!wasEncrypted) return event;

  const tagsToEncrypt = event.tags.filter(t => t[0] !== 'p' && t[0] !== 'e');
  const encText = await nip04.encrypt(NOSTR_PRIVATE_KEY, recipentPubKey, JSON.stringify(tagsToEncrypt));

  return {
    ...event,
    content: encText,
    tags: (event.tags = [...event.tags.filter(t => t[0] == 'e'), ['p', recipentPubKey], ['encrypted']]),
  };
}

async function ensureDecrypted(event: NostrEvent) {
  const encrypted = event.tags.some(t => t[0] == 'encrypted');
  if (encrypted) {
    const encryptedTags = await nip04.decrypt(NOSTR_PRIVATE_KEY, event.pubkey, event.content);
    return {
      wasEncrypted: true,
      event: {
        ...event,
        tags: event.tags.filter(t => t[0] !== 'encrypted').concat(JSON.parse(encryptedTags)),
      },
    };
  }
  return { wasEncrypted: false, event };
}

const seen = new Set<string>();
async function handleEvent(event: NostrEvent) {
  if (event.kind === DVM_VIDEO_THUMB_REQUEST_KIND && !seen.has(event.id)) {
    try {
      seen.add(event.id);
      const { wasEncrypted, event: decryptedEvent } = await ensureDecrypted(event);
      const context = await shouldAcceptJob(decryptedEvent);
      context.wasEncrypted = wasEncrypted;
      try {
        await doWork(context);
      } catch (e) {
        if (e instanceof Error) {
          logger(`Failed to process request ${decryptedEvent.id} because`, e.message);
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

const subscriptions: { [key: string]: Subscription } = {};

const filters: Filter[] = [{ kinds: [DVM_VIDEO_THUMB_REQUEST_KIND], since: dayjs().unix() }];

async function ensureSubscriptions() {
  logger(
    `ensureSubscriptions`,
    JSON.stringify(Object.entries(subscriptions).map(([k, v]) => ({ k, closed: v.closed })))
  );
  for (const url of NOSTR_RELAYS) {
    const existing = subscriptions[url];

    if (!existing || existing.closed) {
      if (existing?.closed) {
        logger(`Reconnecting to ${url}`);
      }
      delete subscriptions[url];
      try {
        const relay = await pool.ensureRelay(url);
        const sub = relay.subscribe(filters, {
          onevent: handleEvent,
          onclose: () => {
            logger('Subscription to', url, 'closed');
            if (subscriptions[url] === sub) delete subscriptions[url];
          },
        });

        logger('Subscribed to', url);
        subscriptions[url] = sub;

        logger(
          `subscriptions after set`,
          JSON.stringify(Object.entries(subscriptions).map(([k, v]) => ({ k, closed: v.closed })))
        );
      } catch (error: any) {
        logger('Failed to reconnect to', url, error.message);
        delete subscriptions[url];
      }
    }
  }
}

async function cleanupBlobs() {
  const pubkey = getPublicKey(NOSTR_PRIVATE_KEY);
  const blobs = await listBlobs(BLOSSOM_UPLOAD_SERVER, pubkey); // TODO add from/until to filter by timestamp

  const cutOffDate = dayjs().unix() - 60 * 60 * 24 * BLOSSOM_BLOB_EXPIRATION_DAYS;
  for (const blob of blobs) {

    if (blob.created < cutOffDate) {
      logger(`Deleting expired blob ${blob.url}`);
      await deleteBlob(BLOSSOM_UPLOAD_SERVER, blob.sha256);
    }
  }
};

await cleanupBlobs();
setInterval(cleanupBlobs, 60 * 60 * 1000); // Clean up blobs every hour

await ensureSubscriptions();
setInterval(ensureSubscriptions, 30_000); // Ensure connections every 30s

async function shutdown() {
  process.exit();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.once('SIGUSR2', shutdown);
