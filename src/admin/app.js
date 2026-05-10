import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Flex, Typography } from '@strapi/design-system';
import { ExternalLink } from '@strapi/icons';
import { useCMEditViewDataManager, useFetchClient, useNotification } from '@strapi/helper-plugin';
import { useRouteMatch } from 'react-router-dom';
import { Device } from '@twilio/voice-sdk';

const APP_USER_UID = 'api::app-user.app-user';
const CONTACT_UID = 'api::contact.contact';
const TENANT_UID = 'api::tenant.tenant';
const TENANT_ADMIN_UID = 'api::tenant-admin.tenant-admin';
const S3_BUCKET = process.env.STRAPI_ADMIN_S3_BUCKET || 'yengtesting';
const S3_REGION = process.env.STRAPI_ADMIN_S3_REGION || 'ap-southeast-1';
const S3_IMAGES_PREFIX = process.env.STRAPI_ADMIN_S3_IMAGES_PREFIX || 'users';

const formatDateTime = (value) => {
  if (!value) return 'Not available';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';

  return date.toLocaleString();
};

const buildS3ConsoleFolderUrl = (tenantSlug, userId) => {
  if (!tenantSlug || !userId || !S3_BUCKET || !S3_REGION) return null;

  const prefix = `${S3_IMAGES_PREFIX}/${tenantSlug}/${userId}/images/`;
  return (
    `https://s3.console.aws.amazon.com/s3/buckets/${S3_BUCKET}` +
    `?region=${encodeURIComponent(S3_REGION)}` +
    `&prefix=${encodeURIComponent(prefix)}` +
    '&showversions=false'
  );
};

const buildCollectionTypeListUrl = (slug, queryParams = {}) => {
  const url = new URL(
    `/admin/content-manager/collectionType/${slug}`,
    window.location.origin
  );

  Object.entries(queryParams).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  return url.toString();
};

const normalizePhone = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';

  const compact = trimmed.replace(/[\s()-]/g, '');
  return compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
};

const formatCallDuration = (seconds) => {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;

  if (hours > 0) {
    return [hours, minutes, remainingSeconds]
      .map((value) => String(value).padStart(2, '0'))
      .join(':');
  }

  return [minutes, remainingSeconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
};

const GalleryPreview = ({ items }) => {
  if (!items.length) {
    return (
      <Typography variant="omega" textColor="neutral500">
        No S3 gallery images found for this user yet.
      </Typography>
    );
  }

  return (
    <div
      style={{
        display: 'grid',
        gap: '12px',
        gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))',
      }}
    >
      {items.map((item) => (
        <a
          key={item.key}
          href={item.signedUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ textDecoration: 'none' }}
        >
          <div
            style={{
              border: '1px solid #dcdce4',
              borderRadius: '8px',
              overflow: 'hidden',
              background: '#ffffff',
            }}
          >
            <img
              src={item.signedUrl}
              alt={item.key}
              style={{
                width: '100%',
                height: '92px',
                objectFit: 'cover',
                display: 'block',
                background: '#f6f6f9',
              }}
            />
          </div>
        </a>
      ))}
    </div>
  );
};

const normalizeGalleryItems = (response) => {
  if (Array.isArray(response?.data?.data)) return response.data.data;
  if (Array.isArray(response?.data)) return response.data;
  return [];
};

const fetchAllEntryIds = async (get, slug) => {
  const pageSize = 100;
  let page = 1;
  let pageCount = 1;
  const ids = [];

  do {
    const response = await get(`/content-manager/collection-types/${slug}`, {
      params: {
        page,
        pageSize,
      },
    });

    const items = response?.data?.results || response?.data || [];
    items.forEach((item) => {
      if (item?.id) {
        ids.push(item.id);
      }
    });

    const pagination = response?.pagination || response?.data?.pagination;
    pageCount = pagination?.pageCount || 1;
    page += 1;
  } while (page <= pageCount);

  return ids;
};

const AppUserPanel = () => {
  const { slug, initialData } = useCMEditViewDataManager();
  const { get } = useFetchClient();
  const toggleNotification = useNotification();
  const [galleryItems, setGalleryItems] = useState([]);
  const [isGalleryLoading, setIsGalleryLoading] = useState(false);

  const isAppUser = slug === APP_USER_UID;
  const userId = initialData?.id;

  const createdAtText = useMemo(
    () => formatDateTime(initialData?.createdAt),
    [initialData?.createdAt]
  );
  const updatedAtText = useMemo(
    () => formatDateTime(initialData?.updatedAt),
    [initialData?.updatedAt]
  );
  const tenantSlug = initialData?.tenant?.slug;
  const userImagesUrl = useMemo(() => buildS3ConsoleFolderUrl(tenantSlug, userId), [tenantSlug, userId]);

  useEffect(() => {
    let isMounted = true;

    const loadGallery = async () => {
      if (!isAppUser || !userId) {
        setGalleryItems([]);
        setIsGalleryLoading(false);
        return;
      }

      try {
        setIsGalleryLoading(true);
        const response = await get(`/app-user-gallery/${userId}`);
        if (!isMounted) return;

        setGalleryItems(normalizeGalleryItems(response));
      } catch (error) {
        if (!isMounted) return;

        setGalleryItems([]);
        toggleNotification({
          type: 'warning',
          message: error?.message || 'Failed to load signed gallery images.',
        });
      } finally {
        if (isMounted) {
          setIsGalleryLoading(false);
        }
      }
    };

    loadGallery();

    return () => {
      isMounted = false;
    };
  }, [get, isAppUser, toggleNotification, userId]);

  if (!isAppUser) return null;

  const openUserContacts = () => {
    if (!userId) return;

    window.location.assign(
      buildCollectionTypeListUrl(CONTACT_UID, {
        page: '1',
        pageSize: '25',
        sort: 'name:asc',
        'filters[user][id][$eq]': String(userId),
      })
    );
  };

  const openUserImages = () => {
    if (!userImagesUrl) return;
    window.open(userImagesUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <Box
      background="neutral0"
      borderColor="neutral200"
      hasRadius
      padding={4}
      shadow="tableShadow"
    >
      <Flex direction="column" gap={3}>
        <Typography variant="pi" textColor="neutral600">
          User Timeline
        </Typography>

        <Box>
          <Typography variant="omega" textColor="neutral600">
            Tenant
          </Typography>
          <Typography variant="pi">{initialData?.tenant?.name || 'Not assigned'}</Typography>
        </Box>

        <Box>
          <Typography variant="omega" textColor="neutral600">
            Created At
          </Typography>
          <Typography variant="pi">{createdAtText}</Typography>
        </Box>

        <Box>
          <Typography variant="omega" textColor="neutral600">
            Updated At
          </Typography>
          <Typography variant="pi">{updatedAtText}</Typography>
        </Box>

        <Button
          variant="secondary"
          size="S"
          endIcon={<ExternalLink />}
          onClick={openUserContacts}
          disabled={!userId}
          fullWidth
        >
          Open User Contacts
        </Button>

        <Button
          variant="secondary"
          size="S"
          endIcon={<ExternalLink />}
          onClick={openUserImages}
          disabled={!userImagesUrl}
          fullWidth
        >
          Open User Images (S3)
        </Button>

        <Box>
          <Typography variant="omega" textColor="neutral600">
            Signed Gallery Preview
          </Typography>
          {isGalleryLoading ? (
            <Typography variant="omega" textColor="neutral500">
              Loading gallery images...
            </Typography>
          ) : (
            <GalleryPreview items={galleryItems} />
          )}
        </Box>

        <Typography variant="omega" textColor="neutral500">
          Opens Contacts filtered by this user, the user's S3 image folder, and shows signed gallery previews.
        </Typography>
      </Flex>
    </Box>
  );
};

const VoiceCallPanel = () => {
  const { slug, initialData } = useCMEditViewDataManager();
  const { get } = useFetchClient();
  const toggleNotification = useNotification();
  const deviceRef = useRef(null);
  const callRef = useRef(null);
  const acceptedAtRef = useRef(null);
  const timerRef = useRef(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isCalling, setIsCalling] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [callDurationSeconds, setCallDurationSeconds] = useState(0);
  const [callStatus, setCallStatus] = useState('Ready to call');

  const supportedSlug = slug === CONTACT_UID || slug === APP_USER_UID;
  const phone = normalizePhone(initialData?.phone);

  useEffect(() => () => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
    }
    callRef.current?.disconnect?.();
    deviceRef.current?.destroy?.();
  }, []);

  if (!supportedSlug || !phone) return null;

  const stopDurationTimer = () => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const resetCallUiState = (nextStatus) => {
    stopDurationTimer();
    callRef.current = null;
    acceptedAtRef.current = null;
    setIsCalling(false);
    setIsPreparing(false);
    setIsMuted(false);
    setCallDurationSeconds(0);
    setCallStatus(nextStatus);
  };

  const startDurationTimer = () => {
    stopDurationTimer();
    acceptedAtRef.current = Date.now();
    setCallDurationSeconds(0);
    timerRef.current = window.setInterval(() => {
      if (!acceptedAtRef.current) return;
      const elapsed = Math.floor((Date.now() - acceptedAtRef.current) / 1000);
      setCallDurationSeconds(elapsed);
    }, 1000);
  };

  const fetchVoiceToken = async () => {
    const response = await get('/twilio/voice/token');
    const payload = response?.data?.data || response?.data;
    if (!payload?.token) {
      throw new Error('Voice token response was missing a token.');
    }

    return payload.token;
  };

  const ensureDevice = async () => {
    if (deviceRef.current) {
      return deviceRef.current;
    }

    const token = await fetchVoiceToken();
    const device = new Device(token, {
      logLevel: 1,
    });

    device.on('registered', () => {
      setCallStatus('Phone ready');
    });

    device.on('error', (error) => {
      const message = error?.message || 'Twilio voice error';
      resetCallUiState(message);
      toggleNotification({
        type: 'warning',
        message,
      });
    });

    device.on('tokenWillExpire', async () => {
      try {
        const nextToken = await fetchVoiceToken();
        await device.updateToken(nextToken);
      } catch (error) {
        toggleNotification({
          type: 'warning',
          message: error?.message || 'Failed to refresh the Twilio voice token.',
        });
      }
    });

    await device.register();
    deviceRef.current = device;
    return device;
  };

  const startCall = async () => {
    if (isPreparing || isCalling) return;

    try {
      setIsPreparing(true);
      setCallStatus(`Preparing call to ${phone}...`);

      const device = await ensureDevice();
      const call = await device.connect({
        params: {
          To: phone,
        },
      });

      callRef.current = call;
      setIsCalling(true);
      setIsMuted(false);
      setCallDurationSeconds(0);
      setCallStatus(`Calling ${phone}...`);

      call.on('accept', () => {
        startDurationTimer();
        setCallStatus(`Connected to ${phone}`);
      });

      call.on('disconnect', () => {
        resetCallUiState('Call ended');
      });

      call.on('cancel', () => {
        resetCallUiState('Call cancelled');
      });

      call.on('error', (error) => {
        const message = error?.message || 'Call failed';
        resetCallUiState(message);
        toggleNotification({
          type: 'warning',
          message,
        });
      });
    } catch (error) {
      const message = error?.message || 'Failed to start the call.';
      setCallStatus(message);
      toggleNotification({
        type: 'warning',
        message,
      });
    } finally {
      setIsPreparing(false);
    }
  };

  const hangUp = () => {
    callRef.current?.disconnect?.();
  };

  const toggleMute = () => {
    const activeCall = callRef.current;
    if (!activeCall || !isCalling) return;

    const nextMutedState = !isMuted;
    activeCall.mute(nextMutedState);
    setIsMuted(nextMutedState);
    setCallStatus(nextMutedState ? 'Call muted' : `Connected to ${phone}`);
  };

  return (
    <Box
      background="neutral0"
      borderColor="neutral200"
      hasRadius
      padding={4}
      shadow="tableShadow"
    >
      <Flex direction="column" gap={3}>
        <Typography variant="pi" textColor="neutral600">
          Twilio Voice
        </Typography>

        <Box>
          <Typography variant="omega" textColor="neutral600">
            Target Number
          </Typography>
          <Typography variant="pi">{phone}</Typography>
        </Box>

        <Flex justifyContent="space-between" alignItems="center" gap={2}>
          <Typography variant="omega" textColor="neutral600">
            Duration
          </Typography>
          <Typography variant="pi">
            {isCalling ? formatCallDuration(callDurationSeconds) : '00:00'}
          </Typography>
        </Flex>

        <Typography variant="omega" textColor="neutral500">
          {callStatus}
        </Typography>

        <Flex gap={2} wrap="wrap">
          <Button
            variant="success"
            size="S"
            onClick={startCall}
            disabled={isPreparing || isCalling}
          >
            {isPreparing ? 'Preparing...' : isCalling ? 'Calling...' : 'Call'}
          </Button>

          <Button
            variant="secondary"
            size="S"
            onClick={toggleMute}
            disabled={!isCalling}
          >
            {isMuted ? 'Unmute' : 'Mute'}
          </Button>

          <Button
            variant="danger-light"
            size="S"
            onClick={hangUp}
            disabled={!isCalling}
          >
            Hang Up
          </Button>
        </Flex>

        <Typography variant="omega" textColor="neutral500">
          Quick call controls for the current record. Uses the Twilio Voice JavaScript SDK inside the Strapi admin UI.
        </Typography>
      </Flex>
    </Box>
  );
};

const normalizeHexColor = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return 'Not set';

  const normalized = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return /^#[0-9A-Fa-f]{6}$/.test(normalized) ? normalized.toUpperCase() : trimmed;
};

const DEFAULT_TENANT_COLOR = '#4D2C91';
const MANAGED_API_KEY_PLACEHOLDER = 'Auto-generated on save';

const findTenantFieldInput = (fieldName) =>
  document.querySelector(
    `input[name="${fieldName}"], textarea[name="${fieldName}"], [name="${fieldName}"] input`
  );

const findTenantFieldContainer = (fieldName) => {
  const input = findTenantFieldInput(fieldName);
  if (!input) return null;

  return (
    input.closest('[data-strapi-field]') ||
    input.closest('[class*="Field"]') ||
    input.parentElement?.parentElement ||
    input.parentElement
  );
};

const findFieldInput = (fieldName) =>
  document.querySelector(
    `input[name="${fieldName}"], textarea[name="${fieldName}"], select[name="${fieldName}"], [name="${fieldName}"] input`
  );

const findFieldContainer = (fieldName) => {
  const input = findFieldInput(fieldName);
  if (!input) return null;

  return (
    input.closest('[data-strapi-field]') ||
    input.closest('[class*="Field"]') ||
    input.parentElement?.parentElement ||
    input.parentElement
  );
};

const useTenantFormEnhancements = ({
  slug,
  initialData,
  modifiedData,
  onChange,
}) => {
  useEffect(() => {
    const isTenantScreen = slug === TENANT_UID;
    if (!isTenantScreen) {
      return undefined;
    }

    if (!initialData?.id && !String(modifiedData?.app_api_key || '').trim()) {
      onChange({
        target: {
          name: 'app_api_key',
          value: MANAGED_API_KEY_PLACEHOLDER,
          type: 'string',
        },
      });
    }

    if (!String(modifiedData?.primary_color || '').trim()) {
      onChange({
        target: {
          name: 'primary_color',
          value: DEFAULT_TENANT_COLOR,
          type: 'string',
        },
      });
    }

    const applyEnhancements = () => {
      const apiKeyInput = findTenantFieldInput('app_api_key');
      const apiKeyContainer = findTenantFieldContainer('app_api_key');
      if (apiKeyContainer) {
        apiKeyContainer.style.display = 'none';
      }

      if (apiKeyInput) {
        apiKeyInput.readOnly = true;
        apiKeyInput.setAttribute('aria-readonly', 'true');
        apiKeyInput.setAttribute('title', 'Use the Tenant Security panel to copy or rotate this key.');
        apiKeyInput.style.backgroundColor = '#f6f6f9';
        apiKeyInput.style.cursor = 'not-allowed';
      }

      const primaryColorInput = findTenantFieldInput('primary_color');
      if (primaryColorInput) {
        const normalized = normalizeHexColor(primaryColorInput.value || primaryColorInput.defaultValue);
        primaryColorInput.type = 'color';
        primaryColorInput.value = normalized === 'Not set' ? DEFAULT_TENANT_COLOR : normalized;
        primaryColorInput.style.padding = '2px';
        primaryColorInput.style.minHeight = '40px';
        primaryColorInput.style.cursor = 'pointer';
      }
    };

    const intervalId = window.setInterval(applyEnhancements, 600);
    applyEnhancements();

    return () => window.clearInterval(intervalId);
  }, [slug, initialData?.id, modifiedData?.app_api_key, modifiedData?.primary_color, onChange]);
};

const useTenantAdminFormEnhancements = ({ slug }) => {
  useEffect(() => {
    if (slug !== TENANT_ADMIN_UID) {
      return undefined;
    }

    const applyEnhancements = () => {
      const adminUserIdContainer = findFieldContainer('admin_user_id');
      if (adminUserIdContainer) {
        adminUserIdContainer.style.display = 'none';
      }

      const adminEmailInput = findFieldInput('admin_email');
      if (adminEmailInput) {
        adminEmailInput.type = 'email';
        adminEmailInput.placeholder = 'Enter the Strapi admin email to assign';
        adminEmailInput.autocomplete = 'email';
      }
    };

    const intervalId = window.setInterval(applyEnhancements, 600);
    applyEnhancements();

    return () => window.clearInterval(intervalId);
  }, [slug]);
};

const ReadOnlyField = ({ label, value, monospace = false }) => (
  <Box
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: '4px',
    }}
  >
    <Typography
      variant="omega"
      textColor="neutral600"
      style={{
        display: 'block',
        width: '100%',
      }}
    >
      {label}
    </Typography>
    <Typography
      variant="pi"
      style={{
        display: 'block',
        width: '100%',
        fontFamily: monospace ? 'monospace' : undefined,
        wordBreak: monospace ? 'break-all' : 'normal',
        lineHeight: 1.5,
      }}
    >
      {value || 'Not set'}
    </Typography>
  </Box>
);

const TenantColorPanel = () => {
  const { slug, initialData, modifiedData, onChange } = useCMEditViewDataManager();
  const isTenantScreen = slug === TENANT_UID;
  useTenantFormEnhancements({ slug, initialData, modifiedData, onChange });
  if (!isTenantScreen) return null;

  const primaryColor = normalizeHexColor(modifiedData?.primary_color || initialData?.primary_color || DEFAULT_TENANT_COLOR);

  return (
    <Box
      background="neutral0"
      borderColor="neutral200"
      hasRadius
      padding={4}
      shadow="tableShadow"
    >
      <Flex direction="column" gap={3}>
        <Typography variant="pi" textColor="neutral600">
          Tenant Branding
        </Typography>

        <ReadOnlyField label="Primary Color Hex" value={primaryColor} monospace />
      </Flex>
    </Box>
  );
};

const TenantKeyPanel = () => {
  const { slug, initialData, modifiedData, onChange } = useCMEditViewDataManager();
  const { post } = useFetchClient();
  const toggleNotification = useNotification();
  const [apiKey, setApiKey] = useState(initialData?.app_api_key || '');
  const [isRotating, setIsRotating] = useState(false);
  const isTenantScreen = slug === TENANT_UID;

  useTenantFormEnhancements({ slug, initialData, modifiedData, onChange });

  useEffect(() => {
    setApiKey(initialData?.app_api_key || '');
  }, [initialData?.app_api_key, initialData?.id]);

  if (!isTenantScreen) return null;

  if (!initialData?.id) {
    return (
      <Box
        background="neutral0"
        borderColor="neutral200"
        hasRadius
        padding={4}
        shadow="tableShadow"
      >
        <Flex direction="column" gap={3}>
          <Typography variant="pi" textColor="neutral600">
            Tenant Security
          </Typography>

          <Typography variant="omega" textColor="neutral500">
            The tenant API key will be generated automatically when you save this tenant for the first time.
          </Typography>
        </Flex>
      </Box>
    );
  }

  const copyApiKey = async () => {
    if (!apiKey) {
      toggleNotification({
        type: 'warning',
        message: 'No tenant API key is available to copy.',
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(apiKey);
      toggleNotification({
        type: 'success',
        message: 'Tenant API key copied.',
      });
    } catch (error) {
      toggleNotification({
        type: 'warning',
        message: 'Unable to copy the tenant API key.',
      });
    }
  };

  const rotateApiKey = async () => {
    const confirmed = window.confirm(
      'Rotate this tenant API key? Existing installed apps using the old key will stop working until rebuilt.'
    );
    if (!confirmed) return;

    try {
      setIsRotating(true);
      const response = await post(`/tenant-api-key/${initialData.id}/rotate`);
      const nextKey = response?.data?.data?.appApiKey || '';
      if (nextKey) {
        setApiKey(nextKey);
      }

      toggleNotification({
        type: 'success',
        message: 'Tenant API key rotated.',
      });
    } catch (error) {
      toggleNotification({
        type: 'warning',
        message: error?.message || 'Failed to rotate the tenant API key.',
      });
    } finally {
      setIsRotating(false);
    }
  };

  return (
    <Box
      background="neutral0"
      borderColor="neutral200"
      hasRadius
      padding={4}
      shadow="tableShadow"
    >
      <Flex direction="column" gap={3}>
        <Typography variant="pi" textColor="neutral600">
          Tenant Security
        </Typography>

        <ReadOnlyField label="Tenant Slug" value={initialData?.slug} />
        <ReadOnlyField label="Android Application Id" value={initialData?.android_application_id} />
        <ReadOnlyField label="Active API Key" value={apiKey} monospace />

        <Flex gap={2} wrap="wrap">
          <Button
            variant="secondary"
            size="S"
            onClick={copyApiKey}
            disabled={!apiKey}
          >
            Copy API Key
          </Button>

          <Button
            variant="danger-light"
            size="S"
            onClick={rotateApiKey}
            disabled={isRotating}
          >
            {isRotating ? 'Rotating...' : 'Rotate API Key'}
          </Button>
        </Flex>
      </Flex>
    </Box>
  );
};

const BulkClearActions = () => {
  const [isClearing, setIsClearing] = useState(false);
  const { get, del } = useFetchClient();
  const toggleNotification = useNotification();
  const match = useRouteMatch('/content-manager/collectionType/:slug');
  const slug = match?.params?.slug;
  const isSupportedList =
    slug === APP_USER_UID || slug === CONTACT_UID || slug === TENANT_UID || slug === TENANT_ADMIN_UID;
  if (!isSupportedList) return null;

  const isUserList = slug === APP_USER_UID;
  const isContactList = slug === CONTACT_UID;
  const label = isUserList
    ? 'Clear All Users'
    : isContactList
      ? 'Clear All Contacts'
      : 'Not Allowed';
  const confirmText = isUserList
    ? 'Clear ALL Users? This will also delete all related Contacts, local profile images, and the users\' S3 gallery images.'
    : isContactList
      ? 'Clear ALL Contacts?'
      : '';

  if (!isUserList && !isContactList) return null;

  const clearAllEntries = async () => {
    if (isClearing) return;

    const confirmed = window.confirm(confirmText);
    if (!confirmed) return;

    try {
      setIsClearing(true);
      const ids = await fetchAllEntryIds(get, slug);

      for (const id of ids) {
        await del(`/content-manager/collection-types/${slug}/${id}`);
      }

      toggleNotification({
        type: 'success',
        message: `${label} completed.`,
      });
      window.location.assign(buildCollectionTypeListUrl(slug));
    } catch (error) {
      const message = error?.message || `Failed to run ${label}.`;
      toggleNotification({
        type: 'warning',
        message,
      });
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <Button
      variant="danger-light"
      size="S"
      onClick={clearAllEntries}
      disabled={isClearing}
    >
      {isClearing ? `${label}...` : label}
    </Button>
  );
};

const DefaultTenantListSort = () => {
  const match = useRouteMatch('/content-manager/collectionType/:slug');
  const slug = match?.params?.slug;

  useEffect(() => {
    if (slug !== TENANT_UID) {
      return;
    }

    const url = new URL(window.location.href);
    const currentSort = url.searchParams.get('sort');
    if (currentSort && currentSort.toLowerCase() !== 'name:asc') {
      return;
    }

    if (currentSort?.toLowerCase() === 'id:asc') {
      return;
    }

    url.searchParams.set('sort', 'id:asc');
    window.location.replace(url.toString());
  }, [slug]);

  return null;
};

const TenantAdminPanel = () => {
  const { slug } = useCMEditViewDataManager();
  useTenantAdminFormEnhancements({ slug });
  return null;
};

const config = {
  locales: [],
};

const bootstrap = (app) => {
  app.injectContentManagerComponent('editView', 'right-links', {
    name: 'voice-call-panel',
    Component: VoiceCallPanel,
  });

  app.injectContentManagerComponent('editView', 'right-links', {
    name: 'app-user-panel',
    Component: AppUserPanel,
  });

  app.injectContentManagerComponent('editView', 'right-links', {
    name: 'tenant-color-panel',
    Component: TenantColorPanel,
  });

  app.injectContentManagerComponent('editView', 'right-links', {
    name: 'tenant-key-panel',
    Component: TenantKeyPanel,
  });

  app.injectContentManagerComponent('editView', 'right-links', {
    name: 'tenant-admin-panel',
    Component: TenantAdminPanel,
  });

  app.injectContentManagerComponent('listView', 'actions', {
    name: 'bulk-clear-actions',
    Component: BulkClearActions,
  });

  app.injectContentManagerComponent('listView', 'actions', {
    name: 'default-tenant-list-sort',
    Component: DefaultTenantListSort,
  });
};

export default {
  config,
  bootstrap,
};
