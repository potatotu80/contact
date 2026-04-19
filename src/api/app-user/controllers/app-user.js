'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { createCoreController } = require('@strapi/strapi').factories;

const APP_USER_UID = 'api::app-user.app-user';

const sanitizeSegment = (value, fallback) => {
  const normalized = (value || fallback).trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  return normalized || fallback;
};

const getFileExtension = (file) => {
  const originalName = file.originalFilename || file.name || '';
  const fromName = path.extname(originalName).trim();
  if (fromName) {
    return fromName.toLowerCase();
  }

  const mimeType = file.type || file.mimetype || '';
  const mimeExtension = mimeType.split('/')[1];
  return mimeExtension ? `.${sanitizeSegment(mimeExtension, 'bin')}` : '.bin';
};

const buildPublicFileUrl = (relativePath) => {
  const publicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/$/, '');
  return publicUrl ? `${publicUrl}${relativePath}` : relativePath;
};

module.exports = createCoreController('api::app-user.app-user', ({ strapi }) => ({
  async contacts(ctx) {
    const userId = Number(ctx.params.id);
    const page = Math.max(1, Number(ctx.query.page) || 1);
    const pageSize = Math.max(1, Math.min(100, Number(ctx.query.pageSize) || 25));
    const start = (page - 1) * pageSize;
    const sort = ctx.query.sort || ['name:asc'];
    const phone = typeof ctx.query.phone === 'string' ? ctx.query.phone.trim() : '';

    if (Number.isNaN(userId)) {
      return ctx.badRequest('User id must be a valid number.');
    }

    const user = await strapi.entityService.findOne('api::app-user.app-user', userId);

    if (!user) {
      return ctx.notFound('User not found.');
    }

    const where = {
      user: {
        id: userId,
      },
    };

    if (phone) {
      where.phone = {
        $eq: phone,
      };
    }

    const [contacts, total] = await Promise.all([
      strapi.entityService.findMany('api::contact.contact', {
        filters: where,
        populate: {
          user: true,
        },
        sort,
        start,
        limit: pageSize,
      }),
      strapi.db.query('api::contact.contact').count({
        where,
      }),
    ]);

    const sanitizedContacts = await this.sanitizeOutput(contacts, ctx);

    return this.transformResponse(sanitizedContacts, {
      pagination: {
        page,
        pageSize,
        pageCount: Math.ceil(total / pageSize),
        total,
      },
    });
  },

  async uploadProfileImage(ctx) {
    const userId = Number(ctx.params.id);
    if (Number.isNaN(userId)) {
      return ctx.badRequest('User id must be a valid number.');
    }

    const user = await strapi.entityService.findOne(APP_USER_UID, userId, {
      fields: ['id', 'image_url'],
    });
    if (!user) {
      return ctx.notFound('User not found.');
    }

    const uploadedFile = Array.isArray(ctx.request.files?.file)
      ? ctx.request.files.file[0]
      : ctx.request.files?.file;

    if (!uploadedFile) {
      return ctx.badRequest('A file field named "file" is required.');
    }

    const mimeType = uploadedFile.type || uploadedFile.mimetype || '';
    if (!mimeType.startsWith('image/')) {
      return ctx.badRequest('Only image uploads are supported.');
    }

    const sourcePath = uploadedFile.filepath || uploadedFile.path;
    if (!sourcePath) {
      return ctx.badRequest('Uploaded file path is missing.');
    }

    const uploadsRoot = path.join(strapi.dirs.static.public, 'uploads', 'user-images', String(userId));
    const extension = getFileExtension(uploadedFile);
    const fileNameBase = sanitizeSegment(
      path.parse(uploadedFile.originalFilename || uploadedFile.name || 'profile-image').name,
      'profile-image'
    );
    const uniquePart = crypto.randomUUID
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString('hex');
    const storedFileName = `${Date.now()}-${uniquePart}-${fileNameBase}${extension}`;
    const destinationPath = path.join(uploadsRoot, storedFileName);

    await fs.mkdir(uploadsRoot, { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
    await fs.unlink(sourcePath).catch(() => {});

    const relativePath = `/uploads/user-images/${userId}/${storedFileName}`;
    const imageUrl = buildPublicFileUrl(relativePath);

    const updatedUser = await strapi.entityService.update(APP_USER_UID, userId, {
      data: {
        image_url: imageUrl,
      },
      fields: ['id', 'email', 'phone', 'ic_number', 'device_id', 'image_url'],
    });

    const sanitizedUser = await this.sanitizeOutput(updatedUser, ctx);

    return this.transformResponse(sanitizedUser, {
      imageUrl,
      relativePath,
    });
  },
}));
