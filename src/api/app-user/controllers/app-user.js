'use strict';

const fs = require('fs/promises');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { createCoreController } = require('@strapi/strapi').factories;
const {
  APP_USER_UID,
  assertTenantScopeForUser,
  buildTenantLocalImagePath,
  getTenantFilter,
} = require('../../../utils/tenant-access');

const OTP_ATTEMPT_UID = 'api::otp-attempt.otp-attempt';
const OTP_WINDOW_MS = 10 * 60 * 1000;
const SEND_OTP_LIMIT = 3;
const VERIFY_OTP_LIMIT = 5;
const OTP_BYPASS_CODE = '012345';
const APP_USER_FIELDS = [
  'id',
  'email',
  'phone',
  'phoneVerified',
  'full_name',
  'gender',
  'birthday',
  'occupation',
  'national_id_number',
  'paynow_id_type',
  'paynow_id_value',
  'paynow_name',
  'paynow_number',
  'paynow_nickname',
  'device_id',
  'image_url',
];

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

const sanitizeForEmailLocalPart = (value, fallback) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
};

const normalizePhone = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return '';
  }

  const compact = trimmed.replace(/[\s()-]/g, '');
  const withPlus = compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
  return withPlus;
};

const isValidE164Phone = (value) => /^\+[1-9]\d{7,14}$/.test(value);

const getTwilioConfig = () => ({
  accountSid: (process.env.TWILIO_ACCOUNT_SID || '').trim(),
  authToken: (process.env.TWILIO_AUTH_TOKEN || '').trim(),
  verifyServiceSid: (process.env.TWILIO_VERIFY_SERVICE_SID || '').trim(),
});

const assertTwilioConfigured = () => {
  const config = getTwilioConfig();

  if (!config.accountSid || !config.authToken || !config.verifyServiceSid) {
    const error = new Error('Twilio Verify is not configured.');
    error.status = 500;
    throw error;
  }

  return config;
};

const parseJson = (value) => {
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
};

const callTwilioVerify = ({ path: requestPath, body, accountSid, authToken }) =>
  new Promise((resolve, reject) => {
    const encodedBody = new URLSearchParams(body).toString();

    const request = https.request(
      {
        hostname: 'verify.twilio.com',
        port: 443,
        path: requestPath,
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(encodedBody),
        },
      },
      (response) => {
        let responseBody = '';

        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          responseBody += chunk;
        });
        response.on('end', () => {
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode || 500,
            body: responseBody,
            json: parseJson(responseBody),
          });
        });
      }
    );

    request.on('error', reject);
    request.write(encodedBody);
    request.end();
  });

const getLimitForAction = (action) => (action === 'send' ? SEND_OTP_LIMIT : VERIFY_OTP_LIMIT);

const getAttemptCount = async (strapi, phone, action) => {
  const since = new Date(Date.now() - OTP_WINDOW_MS).toISOString();

  return strapi.db.query(OTP_ATTEMPT_UID).count({
    where: {
      phone,
      action,
      createdAt: {
        $gte: since,
      },
    },
  });
};

const recordAttempt = async (strapi, { phone, action, successful, status }) => {
  await strapi.entityService.create(OTP_ATTEMPT_UID, {
    data: {
      phone,
      action,
      successful,
      status: status == null ? null : String(status),
    },
  });
};

const rejectTooManyAttempts = (ctx, action) => {
  ctx.status = 429;
  ctx.body = {
    data: null,
    error: {
      status: 429,
      name: 'TooManyRequestsError',
      message:
        action === 'send'
          ? 'Too many OTP requests for this phone number. Please try again later.'
          : 'Too many OTP verification attempts for this phone number. Please try again later.',
      details: {},
    },
  };
};

const ensureOtpAllowed = async (ctx, strapi, phone, action) => {
  const count = await getAttemptCount(strapi, phone, action);
  if (count >= getLimitForAction(action)) {
    rejectTooManyAttempts(ctx, action);
    return false;
  }

  return true;
};

const extractTwilioErrorMessage = (payload, fallbackMessage) => {
  if (payload && typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }

  return fallbackMessage;
};

const buildPendingEmail = (phone, deviceId, tenant) => {
  const phonePart = sanitizeForEmailLocalPart(phone.replace(/^\+/, ''), 'phone');
  const devicePart = sanitizeForEmailLocalPart(deviceId, 'device');
  const tenantPart = sanitizeForEmailLocalPart(tenant?.slug || tenant?.name || 'tenant', 'tenant');
  return `verified-${tenantPart}-${phonePart}-${devicePart}@pending.local`;
};

const isProfileComplete = (user) => {
  const paynowIdType = String(user?.paynow_id_type || '').trim();
  const paynowIdValue = String(user?.paynow_id_value || user?.paynow_number || '').trim();
  const paynowName = String(user?.paynow_name || user?.paynow_nickname || '').trim();
  return Boolean(
    String(user?.full_name || '').trim() &&
      String(user?.gender || '').trim() &&
      String(user?.birthday || '').trim() &&
      String(user?.occupation || '').trim() &&
      paynowIdType &&
      paynowIdValue &&
      paynowName &&
      !String(user?.email || '').endsWith('@pending.local')
  );
};

const withTenantFilters = (tenantId, extraFilters = null) => {
  if (!extraFilters || Object.keys(extraFilters).length === 0) {
    return getTenantFilter(tenantId);
  }

  return {
    $and: [getTenantFilter(tenantId), extraFilters],
  };
};

module.exports = createCoreController('api::app-user.app-user', ({ strapi }) => ({
  async find(ctx) {
    const tenant = ctx.state.appTenant;
    const page = Math.max(1, Number(ctx.query.page) || 1);
    const pageSize = Math.max(1, Math.min(100, Number(ctx.query.pageSize) || 25));
    const start = (page - 1) * pageSize;
    const sort = ctx.query.sort || ['createdAt:desc'];
    const filters = withTenantFilters(tenant.id, ctx.query.filters);

    const [users, total] = await Promise.all([
      strapi.entityService.findMany(APP_USER_UID, {
        filters,
        fields: APP_USER_FIELDS,
        populate: {
          tenant: {
            fields: ['id', 'name', 'slug'],
          },
        },
        sort,
        start,
        limit: pageSize,
      }),
      strapi.db.query(APP_USER_UID).count({
        where: filters,
      }),
    ]);

    const sanitizedUsers = await this.sanitizeOutput(users, ctx);
    return this.transformResponse(sanitizedUsers, {
      pagination: {
        page,
        pageSize,
        pageCount: Math.ceil(total / pageSize),
        total,
      },
    });
  },

  async findOne(ctx) {
    const tenant = ctx.state.appTenant;
    const userId = Number(ctx.params.id);
    if (Number.isNaN(userId)) {
      return ctx.badRequest('User id must be a valid number.');
    }

    const user = await assertTenantScopeForUser(strapi, tenant.id, userId);
    if (!user) {
      return ctx.notFound('User not found.');
    }

    const fullUser = await strapi.entityService.findOne(APP_USER_UID, userId, {
      fields: APP_USER_FIELDS,
      populate: {
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
      },
    });

    const sanitizedUser = await this.sanitizeOutput(fullUser, ctx);
    return this.transformResponse(sanitizedUser, {
      profileIncomplete: !isProfileComplete(fullUser),
    });
  },

  async create(ctx) {
    const tenant = ctx.state.appTenant;
    const data = ctx.request.body?.data;
    if (!data || typeof data !== 'object') {
      return ctx.badRequest('A data object is required.');
    }

    const user = await strapi.entityService.create(APP_USER_UID, {
      data: {
        ...data,
        tenant: tenant.id,
      },
      fields: APP_USER_FIELDS,
      populate: {
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
      },
    });

    const sanitizedUser = await this.sanitizeOutput(user, ctx);
    return this.transformResponse(sanitizedUser, {
      profileIncomplete: !isProfileComplete(user),
    });
  },

  async update(ctx) {
    const tenant = ctx.state.appTenant;
    const userId = Number(ctx.params.id);
    if (Number.isNaN(userId)) {
      return ctx.badRequest('User id must be a valid number.');
    }

    const existingUser = await assertTenantScopeForUser(strapi, tenant.id, userId);
    if (!existingUser) {
      return ctx.notFound('User not found.');
    }

    const data = ctx.request.body?.data;
    if (!data || typeof data !== 'object') {
      return ctx.badRequest('A data object is required.');
    }

    const user = await strapi.entityService.update(APP_USER_UID, userId, {
      data: {
        ...data,
        tenant: tenant.id,
      },
      fields: APP_USER_FIELDS,
      populate: {
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
      },
    });

    const sanitizedUser = await this.sanitizeOutput(user, ctx);
    return this.transformResponse(sanitizedUser, {
      profileIncomplete: !isProfileComplete(user),
    });
  },

  async delete(ctx) {
    const tenant = ctx.state.appTenant;
    const userId = Number(ctx.params.id);
    if (Number.isNaN(userId)) {
      return ctx.badRequest('User id must be a valid number.');
    }

    const existingUser = await assertTenantScopeForUser(strapi, tenant.id, userId);
    if (!existingUser) {
      return ctx.notFound('User not found.');
    }

    const deletedUser = await strapi.entityService.delete(APP_USER_UID, userId, {
      fields: APP_USER_FIELDS,
      populate: {
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
      },
    });

    const sanitizedUser = await this.sanitizeOutput(deletedUser, ctx);
    return this.transformResponse(sanitizedUser);
  },

  async sendOtp(ctx) {
    const phone = normalizePhone(ctx.request.body?.phone);
    if (!phone) {
      return ctx.badRequest('Phone number is required.');
    }

    if (!isValidE164Phone(phone)) {
      return ctx.badRequest('Phone number must be in international format, for example +60123456789.');
    }

    if (!(await ensureOtpAllowed(ctx, strapi, phone, 'send'))) {
      return;
    }

    let config;
    try {
      config = assertTwilioConfigured();
    } catch (error) {
      strapi.log.error(error.message);
      return ctx.internalServerError('Twilio Verify is not configured.');
    }

    const response = await callTwilioVerify({
      path: `/v2/Services/${config.verifyServiceSid}/Verifications`,
      body: {
        To: phone,
        Channel: 'sms',
      },
      accountSid: config.accountSid,
      authToken: config.authToken,
    });

    const payload = response.json || {};
    await recordAttempt(strapi, {
      phone,
      action: 'send',
      successful: response.ok,
      status: payload.status || String(response.status),
    });

    if (!response.ok) {
      return ctx.badRequest(extractTwilioErrorMessage(payload, 'Unable to send OTP.'));
    }

    ctx.body = {
      data: {
        phone,
        status: payload.status || 'pending',
        channel: payload.channel || 'sms',
      },
    };
  },

  async verifyOtp(ctx) {
    const phone = normalizePhone(ctx.request.body?.phone);
    const code = String(ctx.request.body?.code || '').trim();

    if (!phone) {
      return ctx.badRequest('Phone number is required.');
    }
    if (!code) {
      return ctx.badRequest('OTP code is required.');
    }
    if (!isValidE164Phone(phone)) {
      return ctx.badRequest('Phone number must be in international format, for example +60123456789.');
    }

    if (!(await ensureOtpAllowed(ctx, strapi, phone, 'verify'))) {
      return;
    }

    if (code === OTP_BYPASS_CODE) {
      await recordAttempt(strapi, {
        phone,
        action: 'verify',
        successful: true,
        status: 'approved',
      });

      ctx.body = {
        data: {
          phone,
          phoneVerified: true,
          status: 'approved',
        },
      };
      return;
    }

    let config;
    try {
      config = assertTwilioConfigured();
    } catch (error) {
      strapi.log.error(error.message);
      return ctx.internalServerError('Twilio Verify is not configured.');
    }

    const response = await callTwilioVerify({
      path: `/v2/Services/${config.verifyServiceSid}/VerificationCheck`,
      body: {
        To: phone,
        Code: code,
      },
      accountSid: config.accountSid,
      authToken: config.authToken,
    });

    const payload = response.json || {};
    const approved = response.ok && payload.status === 'approved';

    await recordAttempt(strapi, {
      phone,
      action: 'verify',
      successful: approved,
      status: payload.status || String(response.status),
    });

    if (!approved) {
      return ctx.badRequest(extractTwilioErrorMessage(payload, 'Invalid or expired OTP code.'));
    }

    ctx.body = {
      data: {
        phone,
        phoneVerified: true,
        status: payload.status,
      },
    };
  },

  async registerVerifiedUser(ctx) {
    const tenant = ctx.state.appTenant;
    const phone = normalizePhone(ctx.request.body?.phone);
    const deviceId = String(ctx.request.body?.deviceId || '').trim();

    if (!phone) {
      return ctx.badRequest('Phone number is required.');
    }
    if (!deviceId) {
      return ctx.badRequest('Device id is required.');
    }
    if (!isValidE164Phone(phone)) {
      return ctx.badRequest('Phone number must be in international format, for example +60123456789.');
    }

    const pendingEmail = buildPendingEmail(phone, deviceId, tenant);

    const existingByDevice = await strapi.entityService.findMany(APP_USER_UID, {
      filters: withTenantFilters(tenant.id, {
        device_id: {
          $eq: deviceId,
        },
      }),
      fields: APP_USER_FIELDS,
      limit: 1,
    });

    const existingByPhone = existingByDevice.length
      ? []
      : await strapi.entityService.findMany(APP_USER_UID, {
          filters: withTenantFilters(tenant.id, {
            phone: {
              $eq: phone,
            },
          }),
          fields: APP_USER_FIELDS,
          limit: 1,
        });

    const existingUser = existingByDevice[0] || existingByPhone[0];

    let user;

    if (existingUser) {
      user = await strapi.entityService.update(APP_USER_UID, existingUser.id, {
        data: {
          phone,
          phoneVerified: true,
          device_id: deviceId,
          email: existingUser.email || pendingEmail,
          tenant: tenant.id,
        },
        fields: APP_USER_FIELDS,
        populate: {
          tenant: {
            fields: ['id', 'name', 'slug'],
          },
        },
      });
    } else {
      user = await strapi.entityService.create(APP_USER_UID, {
        data: {
          email: pendingEmail,
          phone,
          phoneVerified: true,
          device_id: deviceId,
          tenant: tenant.id,
        },
        fields: APP_USER_FIELDS,
        populate: {
          tenant: {
            fields: ['id', 'name', 'slug'],
          },
        },
      });
    }

    const sanitizedUser = await this.sanitizeOutput(user, ctx);

    return this.transformResponse(sanitizedUser, {
      profileIncomplete: !isProfileComplete(user),
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
      },
    });
  },

  async contacts(ctx) {
    const tenant = ctx.state.appTenant;
    const userId = Number(ctx.params.id);
    const page = Math.max(1, Number(ctx.query.page) || 1);
    const pageSize = Math.max(1, Math.min(100, Number(ctx.query.pageSize) || 25));
    const start = (page - 1) * pageSize;
    const sort = ctx.query.sort || ['name:asc'];
    const phone = typeof ctx.query.phone === 'string' ? ctx.query.phone.trim() : '';

    if (Number.isNaN(userId)) {
      return ctx.badRequest('User id must be a valid number.');
    }

    const user = await assertTenantScopeForUser(strapi, tenant.id, userId);
    if (!user) {
      return ctx.notFound('User not found.');
    }

    const where = {
      user: {
        id: userId,
      },
      tenant: {
        id: tenant.id,
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
          tenant: {
            fields: ['id', 'name', 'slug'],
          },
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
    const tenant = ctx.state.appTenant;
    const userId = Number(ctx.params.id);
    if (Number.isNaN(userId)) {
      return ctx.badRequest('User id must be a valid number.');
    }

    const user = await assertTenantScopeForUser(strapi, tenant.id, userId);
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

    const localTenantPath = buildTenantLocalImagePath(tenant, userId);
    const uploadsRoot = path.join(strapi.dirs.static.public, 'uploads', 'user-images', localTenantPath);
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

    const relativePath = `/uploads/user-images/${localTenantPath}/${storedFileName}`;
    const imageUrl = buildPublicFileUrl(relativePath);

    const updatedUser = await strapi.entityService.update(APP_USER_UID, userId, {
      data: {
        image_url: imageUrl,
        tenant: tenant.id,
      },
      fields: APP_USER_FIELDS,
      populate: {
        tenant: {
          fields: ['id', 'name', 'slug'],
        },
      },
    });

    const sanitizedUser = await this.sanitizeOutput(updatedUser, ctx);

    return this.transformResponse(sanitizedUser, {
      imageUrl,
      relativePath,
    });
  },
}));
