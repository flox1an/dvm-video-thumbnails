import { Signer } from "blossom-client-sdk";
import { EventTemplate, finalizeEvent } from "nostr-tools";
import { NOSTR_PRIVATE_KEY } from "../env.js";
import dayjs from "dayjs";
import { getFileSizeSync } from "./filesystem.js";
import { createReadStream } from "fs";
import axios from "axios";
import debug from "debug";

const logger = debug("dvm:blossom");

type BlobDescriptor = {
    created: number;
    type?: string;
    sha256: string;
    size: number;
    url: string;
  };
  

const signer: Signer = async (event: EventTemplate) => {
    return new Promise((resolve, reject) => {
      try {
        const verifiedEvent = finalizeEvent(event, NOSTR_PRIVATE_KEY);
        resolve(verifiedEvent);
      } catch (error) {
        reject(error);
      }
    });
  };

export async function uploadFile(filePath: string, server: string): Promise<BlobDescriptor> {
    try {
      const oneHour = () => dayjs().unix() + 60 * 60;
      const authEvent = await signer({
        created_at: dayjs().unix(),
        kind: 24242,
        content: "Upload thumbail",
        tags: [
          ["t", "upload"],
          // ["name", ], unknown
          ["size", String(getFileSizeSync(filePath))],
          ["expiration", String(oneHour)],
        ],
      });
  
      // Create a read stream for the thumbnail file
      const thumbnailStream = createReadStream(filePath);
  
      // Upload thumbnail stream using axios
      const blob = await axios.put<BlobDescriptor>(`${server}/upload`, thumbnailStream, {
        headers: {
          "Content-Type": "image/jpeg", // Adjust content type as needed    <--- TODO adjust for png
          authorization: "Nostr " + btoa(JSON.stringify(authEvent)),
        },
      });
  
      logger(`File ${filePath} uploaded successfully.`);
      return blob.data;
    } catch (error: any) {
      throw new Error(`Failed to upload thumbnail ${filePath}: ${error.message}`);
    }
  }