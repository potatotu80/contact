import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Flex, Typography } from '@strapi/design-system';
import { ExternalLink } from '@strapi/icons';
import { useCMEditViewDataManager, useFetchClient, useNotification } from '@strapi/helper-plugin';
import { useRouteMatch } from 'react-router-dom';
import { Device } from '@twilio/voice-sdk';

const APP_USER_UID = 'api::app-user.app-user';
const CONTACT_UID = 'api::contact.contact';
const S3_BUCKET = process.env.STRAPI_ADMIN_S3_BUCKET || 'yengtesting';
const S3_REGION = process.env.STRAPI_ADMIN_S3_REGION || 'ap-southeast-1';
const S3_IMAGES_PREFIX = process.env.STRAPI_ADMIN_S3_IMAGES_PREFIX || 'users';

const formatDateTime = (value) => {
  if (!value) return 'Not available';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';

  return date.toLocaleString();
};

const buildS3ConsoleFolderUrl = (userId) => {
  if (!userId || !S3_BUCKET || !S3_REGION) return null;

  const prefix = `${S3_IMAGES_PREFIX}/${userId}/images/`;
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
  const userImagesUrl = useMemo(() => buildS3ConsoleFolderUrl(userId), [userId]);

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
  const [isPreparing, setIsPreparing] = useState(false);
  const [isCalling, setIsCalling] = useState(false);
  const [callStatus, setCallStatus] = useState('Ready to call');

  const supportedSlug = slug === CONTACT_UID || slug === APP_USER_UID;
  const phone = normalizePhone(initialData?.phone);

  useEffect(() => () => {
    callRef.current?.disconnect?.();
    deviceRef.current?.destroy?.();
  }, []);

  if (!supportedSlug || !phone) return null;

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
      setCallStatus(message);
      setIsPreparing(false);
      setIsCalling(false);
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
      setCallStatus(`Calling ${phone}...`);

      call.on('accept', () => {
        setCallStatus(`Connected to ${phone}`);
      });

      call.on('disconnect', () => {
        callRef.current = null;
        setIsCalling(false);
        setCallStatus('Call ended');
      });

      call.on('cancel', () => {
        callRef.current = null;
        setIsCalling(false);
        setCallStatus('Call cancelled');
      });

      call.on('error', (error) => {
        callRef.current = null;
        setIsCalling(false);
        const message = error?.message || 'Call failed';
        setCallStatus(message);
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

        <Typography variant="omega" textColor="neutral500">
          {callStatus}
        </Typography>

        <Button
          variant="success"
          size="S"
          onClick={startCall}
          disabled={isPreparing || isCalling}
          fullWidth
        >
          {isPreparing ? 'Preparing...' : isCalling ? 'Calling...' : 'Start Voice Call'}
        </Button>

        <Button
          variant="secondary"
          size="S"
          onClick={hangUp}
          disabled={!isCalling}
          fullWidth
        >
          Hang Up
        </Button>

        <Typography variant="omega" textColor="neutral500">
          Uses the Twilio Voice JavaScript SDK in the Strapi admin UI to place outbound calls to this record.
        </Typography>
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
  const isSupportedList = slug === APP_USER_UID || slug === CONTACT_UID;
  if (!isSupportedList) return null;

  const isUserList = slug === APP_USER_UID;
  const label = isUserList ? 'Clear All Users' : 'Clear All Contacts';
  const confirmText = isUserList
    ? 'Clear ALL Users? This will also delete all related Contacts, local profile images, and the users\' S3 gallery images.'
    : 'Clear ALL Contacts?';

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

const config = {
  locales: [],
};

const bootstrap = (app) => {
  app.injectContentManagerComponent('editView', 'right-links', {
    name: 'app-user-panel',
    Component: AppUserPanel,
  });

  app.injectContentManagerComponent('editView', 'right-links', {
    name: 'voice-call-panel',
    Component: VoiceCallPanel,
  });

  app.injectContentManagerComponent('listView', 'actions', {
    name: 'bulk-clear-actions',
    Component: BulkClearActions,
  });
};

export default {
  config,
  bootstrap,
};
