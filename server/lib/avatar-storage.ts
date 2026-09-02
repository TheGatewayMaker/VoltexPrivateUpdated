import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

let avatarClient: S3Client | null = null;

function getAvatarBucketName(): string {
  const bucketName =
    process.env.R2_AVATAR_BUCKET_NAME || process.env.R2_BUCKET_NAME;

  if (!bucketName) {
    throw new Error("R2 avatar bucket is not configured");
  }

  return bucketName;
}

function getAvatarEndpoint(): string {
  if (process.env.R2_ENDPOINT_URL) {
    return process.env.R2_ENDPOINT_URL;
  }

  const accountId = process.env.R2_ACCOUNT_ID;
  if (!accountId) {
    throw new Error("R2 endpoint is not configured");
  }

  return `https://${accountId}.r2.cloudflarestorage.com`;
}

function getAvatarClient(): S3Client {
  if (avatarClient) {
    return avatarClient;
  }

  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("R2 avatar credentials are incomplete");
  }

  avatarClient = new S3Client({
    region: "auto",
    endpoint: getAvatarEndpoint(),
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  return avatarClient;
}

function getAvatarExtension(contentType: string): "jpg" | "png" {
  return contentType === "image/png" ? "png" : "jpg";
}

export function buildAvatarObjectKey(userId: string, contentType: string): string {
  return `avatars/${userId}/profile.${getAvatarExtension(contentType)}`;
}

export async function uploadAvatarObject(params: {
  userId: string;
  contentType: "image/jpeg" | "image/png";
  buffer: Buffer;
}): Promise<string> {
  const bucketName = getAvatarBucketName();
  const client = getAvatarClient();
  const key = buildAvatarObjectKey(params.userId, params.contentType);

  await client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: params.buffer,
      ContentType: params.contentType,
      CacheControl: "public, max-age=31536000, immutable",
      ContentLength: params.buffer.length,
    }),
  );

  const staleKey =
    params.contentType === "image/png"
      ? buildAvatarObjectKey(params.userId, "image/jpeg")
      : buildAvatarObjectKey(params.userId, "image/png");

  if (staleKey !== key) {
    await deleteAvatarObject(staleKey);
  }

  return key;
}

export async function getAvatarObject(key: string): Promise<{
  body: Buffer;
  contentType: string;
  etag?: string;
  lastModified?: Date;
} | null> {
  const bucketName = getAvatarBucketName();
  const client = getAvatarClient();

  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
      }),
    );

    if (!response.Body) {
      return null;
    }

    const body = Buffer.from(await response.Body.transformToByteArray());

    return {
      body,
      contentType: response.ContentType || "application/octet-stream",
      etag: response.ETag,
      lastModified: response.LastModified,
    };
  } catch (error) {
    const errorName =
      typeof error === "object" && error && "name" in error
        ? String(error.name)
        : "";

    if (errorName === "NoSuchKey") {
      return null;
    }

    throw error;
  }
}

export async function deleteAvatarObject(key: string | null | undefined): Promise<void> {
  if (!key) {
    return;
  }

  const bucketName = getAvatarBucketName();
  const client = getAvatarClient();

  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: key,
      }),
    );
  } catch (error) {
    const errorName =
      typeof error === "object" && error && "name" in error
        ? String(error.name)
        : "";

    if (errorName === "NoSuchKey") {
      return;
    }

    throw error;
  }
}
