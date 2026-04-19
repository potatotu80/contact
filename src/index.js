'use strict';

const AWS = require('aws-sdk');

const APP_USER_UID = 'api::app-user.app-user';

const parsePositiveInt = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const buildS3ObjectUrl = (bucket, region, key) => {
  const encodedKey = key
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;
};

module.exports = {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register({ strapi }) {
    strapi.server.routes([
      {
        method: 'GET',
        path: '/app-user-gallery/:id',
        handler: async (ctx) => {
          const userId = parsePositiveInt(ctx.params.id);
          if (!userId) {
            return ctx.badRequest('User id must be a valid number.');
          }

          const bucket = process.env.S3_BUCKET_NAME;
          const region = process.env.AWS_REGION;
          const prefixBase = process.env.S3_IMAGES_PREFIX || 'users';
          const expiresIn = parsePositiveInt(process.env.S3_PRESIGN_EXPIRES_IN) || 900;

          if (!bucket || !region) {
            return ctx.internalServerError('S3 configuration missing: S3_BUCKET_NAME or AWS_REGION.');
          }

          const user = await strapi.entityService.findOne(APP_USER_UID, userId, {
            fields: ['id'],
          });
          if (!user) {
            return ctx.notFound('User not found.');
          }

          const s3Client = new AWS.S3({
            region,
            signatureVersion: 'v4',
          });

          const prefix = `${prefixBase}/${userId}/images/`;
          const listed = await s3Client.listObjectsV2({
            Bucket: bucket,
            Prefix: prefix,
            MaxKeys: 100,
          }).promise();

          const items = await Promise.all(
            (listed.Contents || [])
              .filter((item) => item.Key)
              .sort((left, right) => {
                const leftTime = new Date(left.LastModified || 0).getTime();
                const rightTime = new Date(right.LastModified || 0).getTime();
                return rightTime - leftTime;
              })
              .map(async (item) => {
                const signedUrl = await s3Client.getSignedUrlPromise('getObject', {
                  Bucket: bucket,
                  Key: item.Key,
                  Expires: expiresIn,
                });

                return {
                  key: item.Key,
                  size: item.Size || 0,
                  lastModified: item.LastModified || null,
                  signedUrl,
                  objectUrl: buildS3ObjectUrl(bucket, region, item.Key),
                };
              })
          );

          ctx.body = {
            data: items,
            meta: {
              bucket,
              region,
              prefix,
              total: items.length,
              expiresIn,
            },
          };
        },
        config: {
          policies: ['admin::isAuthenticatedAdmin'],
        },
      },
    ]);
  },

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  bootstrap(/*{ strapi }*/) {},
};
