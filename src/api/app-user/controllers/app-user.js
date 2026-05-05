'use strict';

const fs = require('fs/promises');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { createCoreController } = require('@strapi/strapi').factories;

const APP_USER_UID = 'api::app-user.app-user';
const OTP_ATTEMPT_UID = 'api::otp-attempt.otp-attempt';
const OTP_WINDOW_MS = 10 * 60 * 1000;
const SEND_OTP_LIMIT = 3;
const VERIFY_OTP_LIMIT = 5;
const APP_USER_FIELDS = [
  'id',
  'email',
  'phone',
  'phoneVerified',
  'full_name',
  'ic_number',
  'national_id_number',
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

const buildPendingEmail = (phone, deviceId) => {
  const phonePart = sanitizeForEmailLocalPart(phone.replace(/^\+/, ''), 'phone');
  const devicePart = sanitizeForEmailLocalPart(deviceId, 'device');
  return `verified-${phonePart}-${devicePart}@pending.local`;
};

const isProfileComplete = (user) => {
  const nationalId = String(user?.national_id_number || user?.ic_number || '').trim();
  return Boolean(
    String(user?.full_name || '').trim() &&
      nationalId &&
      String(user?.paynow_number || '').trim() &&
      String(user?.paynow_nickname || '').trim() &&
      !String(user?.email || '').endsWith('@pending.local')
  );
};

module.exports = createCoreController('api::app-user.app-user', ({ strapi }) => ({
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

    const pendingEmail = buildPendingEmail(phone, deviceId);

    const existingByDevice = await strapi.entityService.findMany(APP_USER_UID, {
      filters: {
        device_id: {
          $eq: deviceId,
        },
      },
      fields: APP_USER_FIELDS,
      limit: 1,
    });

    const existingByPhone = existingByDevice.length
      ? []
      : await strapi.entityService.findMany(APP_USER_UID, {
          filters: {
            phone: {
              $eq: phone,
            },
          },
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
        },
        fields: APP_USER_FIELDS,
      });
    } else {
      user = await strapi.entityService.create(APP_USER_UID, {
        data: {
          email: pendingEmail,
          phone,
          phoneVerified: true,
          device_id: deviceId,
        },
        fields: APP_USER_FIELDS,
      });
    }

    const sanitizedUser = await this.sanitizeOutput(user, ctx);

    return this.transformResponse(sanitizedUser, {
      profileIncomplete: !isProfileComplete(user),
    });
  },

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
      fields: APP_USER_FIELDS,
    });

    const sanitizedUser = await this.sanitizeOutput(updatedUser, ctx);

    return this.transformResponse(sanitizedUser, {
      imageUrl,
      relativePath,
    });
  },
}));
