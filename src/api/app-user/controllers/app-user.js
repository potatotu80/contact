'use strict';

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::app-user.app-user', ({ strapi }) => ({
  async contacts(ctx) {
    const userId = Number(ctx.params.id);
    const page = Math.max(1, Number(ctx.query.page) || 1);
    const pageSize = Math.max(1, Math.min(100, Number(ctx.query.pageSize) || 25));
    const start = (page - 1) * pageSize;
    const sort = ctx.query.sort || ['name:asc'];

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
}));
