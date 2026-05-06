'use strict';

const crypto = require('crypto');
const AWS = require('aws-sdk');
const {
  APP_USER_UID,
  assertTenantScopeForUser,
  buildTenantUserImagePrefix,
} = require('../../../utils/tenant-access');

const sanitizeFileName = (fileName) => {
  const base = (fileName || 'image.jpg').trim();
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe || 'image.jpg';
};

const buildS3ObjectUrl = (bucket, region, key) => {
  const encodedKey = key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;
};

const parsePositiveInt = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const resolveUserId = async ({ strapi, tenantId, userId, userEmail }) => {
  const parsedId = parsePositiveInt(userId);
  if (parsedId) {
    const tenantScopedUser = await assertTenantScopeForUser(strapi, tenantId, parsedId);
    return tenantScopedUser?.id || null;
  }

  if (!userEmail) {
    return null;
  }

  const users = await strapi.entityService.findMany(APP_USER_UID, {
    filters: {
      $and: [
        {
          email: {
            $eq: userEmail,
          },
        },
        {
          tenant: {
            id: {
              $eq: tenantId,
            },
          },
        },
      ],
    },
    fields: ['id'],
    limit: 1,
  });

  return users[0]?.id || null;
};

module.exports = {
  async presign(ctx) {
    const tenant = ctx.state.appTenant;
    const {
      fileName,
      contentType,
      userId,
      userEmail,
    } = ctx.request.body || {};

    if (!fileName || !contentType) {
      return ctx.badRequest('fileName and contentType are required.');
    }

    const bucket = process.env.S3_BUCKET_NAME;
    const region = process.env.AWS_REGION;
    const prefix = process.env.S3_IMAGES_PREFIX || 'users';
    const expiresIn = parsePositiveInt(process.env.S3_PRESIGN_EXPIRES_IN) || 900;

    if (!bucket || !region) {
      return ctx.internalServerError('S3 configuration missing: S3_BUCKET_NAME or AWS_REGION.');
    }

    const resolvedUserId = await resolveUserId({
      strapi,
      tenantId: tenant.id,
      userId,
      userEmail,
    });
    if (!resolvedUserId) {
      return ctx.badRequest('A valid tenant userId (or userEmail that resolves to one tenant user) is required.');
    }

    const appUser = await strapi.entityService.findOne(APP_USER_UID, resolvedUserId, {
      fields: ['id'],
      populate: {
        tenant: {
          fields: ['id', 'slug', 'name'],
        },
      },
    });

    if (!appUser) {
      return ctx.notFound('User not found.');
    }

    const safeFileName = sanitizeFileName(fileName);
    const uniquePart = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const keyPrefix = buildTenantUserImagePrefix(appUser.tenant, resolvedUserId, prefix);
    const objectKey = `${keyPrefix}/${Date.now()}-${uniquePart}-${safeFileName}`;

    const s3Client = new AWS.S3({
      region,
      signatureVersion: 'v4',
    });

    const uploadUrl = await s3Client.getSignedUrlPromise('putObject', {
      Bucket: bucket,
      Key: objectKey,
      ContentType: contentType,
      Expires: expiresIn,
    });

    const consoleFolderUrl =
      `https://s3.console.aws.amazon.com/s3/buckets/${bucket}` +
      `?region=${encodeURIComponent(region)}` +
      `&prefix=${encodeURIComponent(`${keyPrefix}/`)}` +
      '&showversions=false';

    ctx.body = {
      uploadUrl,
      headers: {
        'Content-Type': contentType,
      },
      key: objectKey,
      userId: resolvedUserId,
      bucket,
      region,
      folderPath: `${keyPrefix}/`,
      fileUrl: buildS3ObjectUrl(bucket, region, objectKey),
      consoleFolderUrl,
      expiresIn,
    };
  },
};
