'use strict';

const { createCoreController } = require('@strapi/strapi').factories;

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
    return;
  }

  const userId = normalizeRelationId(data.user);
  if (userId) {
    data.user = {
      connect: [{ id: userId }],
    };
  }
};

module.exports = createCoreController('api::contact.contact', () => ({
  async create(ctx) {
    normalizeContactUserRelation(ctx);
    return super.create(ctx);
  },

  async update(ctx) {
    normalizeContactUserRelation(ctx);
    return super.update(ctx);
  },
}));
