'use strict';

const { createCoreController } = require('@strapi/strapi').factories;
const CONTACT_UID = 'api::contact.contact';
const APP_USER_UID = 'api::app-user.app-user';

const normalizeRelationId = (value) => {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  if (typeof value.id === 'number' && Number.isInteger(value.id)) {
    return value.id;
  }

  if (value.data && typeof value.data === 'object') {
    return normalizeRelationId(value.data);
  }

  if (Array.isArray(value.connect) && value.connect.length > 0) {
    return normalizeRelationId(value.connect[0]);
  }

  if (Array.isArray(value.set) && value.set.length > 0) {
    return normalizeRelationId(value.set[0]);
  }

  return null;
};

const normalizeContactUserRelation = (ctx) => {
  const data = ctx.request.body?.data;
  if (!data || !Object.prototype.hasOwnProperty.call(data, 'user')) {
    return null;
  }

  const userId = normalizeRelationId(data.user);
  if (userId) {
    return userId;
  }

  return null;
};

module.exports = createCoreController(CONTACT_UID, ({ strapi }) => ({
  async create(ctx) {
    const data = ctx.request.body?.data;
    if (!data || typeof data !== 'object') {
      return ctx.badRequest('A data object is required.');
    }

    const userId = normalizeContactUserRelation(ctx);
    if (!userId) {
      return ctx.badRequest('User must be defined.');
    }

    const user = await strapi.entityService.findOne(APP_USER_UID, userId, {
      fields: ['id'],
    });
    if (!user) {
      return ctx.badRequest('User must reference an existing app user.');
    }

    const payload = {
      ...data,
      user: userId,
    };

    const created = await strapi.entityService.create(CONTACT_UID, {
      data: payload,
      populate: {
        user: true,
      },
    });

    const sanitized = await this.sanitizeOutput(created, ctx);
    return this.transformResponse(sanitized);
  },

  async update(ctx) {
    const contactId = Number(ctx.params.id);
    if (Number.isNaN(contactId)) {
      return ctx.badRequest('Contact id must be a valid number.');
    }

    const data = ctx.request.body?.data;
    if (!data || typeof data !== 'object') {
      return ctx.badRequest('A data object is required.');
    }

    const payload = {
      ...data,
    };

    if (Object.prototype.hasOwnProperty.call(data, 'user')) {
      const userId = normalizeContactUserRelation(ctx);
      if (!userId) {
        return ctx.badRequest('User must be defined.');
      }

      const user = await strapi.entityService.findOne(APP_USER_UID, userId, {
        fields: ['id'],
      });
      if (!user) {
        return ctx.badRequest('User must reference an existing app user.');
      }

      payload.user = userId;
    }

    const updated = await strapi.entityService.update(CONTACT_UID, contactId, {
      data: payload,
      populate: {
        user: true,
      },
    });

    const sanitized = await this.sanitizeOutput(updated, ctx);
    return this.transformResponse(sanitized);
  },
}));
