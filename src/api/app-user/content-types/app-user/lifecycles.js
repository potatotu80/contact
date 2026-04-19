'use strict';

const fs = require('fs/promises');
const path = require('path');
const AWS = require('aws-sdk');

const CONTACT_UID = 'api::contact.contact';

const extractDeleteId = (where) => {
  if (!where) return null;

  if (typeof where.id === 'number') return where.id;
  if (typeof where.id === 'string') {
    const parsed = Number(where.id);
    return Number.isNaN(parsed) ? null : parsed;
  }

  if (typeof where.id === 'object') {
    if (typeof where.id.$eq === 'number') return where.id.$eq;
    if (typeof where.id.$eq === 'string') {
      const parsed = Number(where.id.$eq);
      return Number.isNaN(parsed) ? null : parsed;
    }
  }

  return null;
};

const deleteS3Prefix = async (userId) => {
  const bucket = process.env.S3_BUCKET_NAME;
  const region = process.env.AWS_REGION;
  const prefixBase = process.env.S3_IMAGES_PREFIX || 'users';
  const prefix = `${prefixBase}/${userId}/images/`;

  if (!bucket || !region) {
    return;
  }

  const s3Client = new AWS.S3({
    region,
    signatureVersion: 'v4',
  });

  let continuationToken;

  do {
    const listed = await s3Client.listObjectsV2({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }).promise();

    const objects = (listed.Contents || [])
      .map((item) => ({ Key: item.Key }))
      .filter((item) => item.Key);

    if (objects.length > 0) {
      await s3Client.deleteObjects({
        Bucket: bucket,
        Delete: {
          Objects: objects,
          Quiet: true,
        },
      }).promise();
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
};

const deleteLocalUserImages = async (userId) => {
  const targetDir = path.join(
    strapi.dirs.static.public,
    'uploads',
    'user-images',
    String(userId)
  );

  await fs.rm(targetDir, { recursive: true, force: true });
};

module.exports = {
  async beforeDelete(event) {
    const userId = extractDeleteId(event.params?.where);
    if (!userId) return;

    await deleteS3Prefix(userId);
    await deleteLocalUserImages(userId);

    await strapi.db.query(CONTACT_UID).deleteMany({
      where: {
        user: {
          id: userId,
        },
      },
    });
  },
};
