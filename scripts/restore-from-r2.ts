import fs from "fs/promises";
import path from "path";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { sdkStreamMixin } from "@aws-sdk/util-stream-node";
import { storageRoot } from "../server/lib/storage-paths";

async function fsyncDirectory(directoryPath: string): Promise<void> {
  const handle = await fs.open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(filePath: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.open(tempPath, "w", 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await fs.rename(tempPath, filePath);
  await fsyncDirectory(path.dirname(filePath));
}

function createClient(): S3Client {
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint = process.env.R2_ENDPOINT_URL;

  if (!accessKeyId || !secretAccessKey || !endpoint) {
    throw new Error("R2 credentials are required for restore");
  }

  return new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
}

async function restoreBucket(client: S3Client, bucket: string): Promise<number> {
  let continuationToken: string | undefined;
  let restored = 0;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      }),
    );

    for (const entry of response.Contents || []) {
      if (!entry.Key) continue;

      const object = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: entry.Key,
        }),
      );
      if (!object.Body) continue;

      const stream = sdkStreamMixin(object.Body);
      const body = await stream.transformToString();
      await atomicWrite(path.join(storageRoot, bucket, entry.Key), body);
      restored += 1;
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return restored;
}

async function main() {
  const client = createClient();
  const buckets = [
    "voltex-users",
    "voltex-recovery",
    "voltex-messages",
    "voltex-system",
    "voltex-protocol",
  ];

  const report: Record<string, number> = {};
  for (const bucket of buckets) {
    report[bucket] = await restoreBucket(client, bucket);
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
