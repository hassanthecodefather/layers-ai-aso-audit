import type postgres from 'postgres';
import { getInFlightListingUpdates, setListingUpdateStatus } from '../queue/listing-update-store';
import type { ListingUpdate } from '../queue/listing-update-store';
import { loadCredentials } from '../asc/credential-store';
import { signAscToken } from '../asc/auth';
import { getGateway } from '../cost/gateway';
import { insertChangeEvent } from './store';
import { insertListingMonitor } from '../queue/listing-monitor-store';

const ASC_BASE = 'https://api.appstoreconnect.apple.com';

const ASC_STATE_MAP: Record<string, 'in_review' | 'approved' | 'rejected' | null> = {
  WAITING_FOR_REVIEW: 'in_review',
  IN_REVIEW: 'in_review',
  PENDING_DEVELOPER_RELEASE: 'in_review',
  READY_FOR_SALE: 'approved',
  REJECTED: 'rejected',
  DEVELOPER_REJECTED: 'rejected',
};

async function checkOneUpdate(sql: postgres.Sql, update: ListingUpdate): Promise<void> {
  const credsResult = await loadCredentials(sql, update.tenantId);
  if (!credsResult.ok || !credsResult.value) return;

  const creds = credsResult.value;
  const token = signAscToken(creds.keyId, creds.issuerId, creds.privateKeyPem);
  const url = `${ASC_BASE}/v1/apps/${encodeURIComponent(update.appId)}/appStoreVersions?filter[platform]=IOS&limit=1&sort=-createdDate`;

  const res = await getGateway().fetch(url, { kind: 'app', upstream: 'asc' }, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await res.json().catch(() => null) as any;
  const version = data?.data?.[0];
  if (!version) return;

  const ascState: string = version.attributes?.appStoreState ?? '';
  const ourStatus = ASC_STATE_MAP[ascState] ?? null;

  if (!ourStatus || ourStatus === update.status) return;

  const isTerminal = ourStatus === 'approved' || ourStatus === 'rejected';
  const resolvedAt = isTerminal ? new Date() : null;

  // For rejections, attempt to fetch rejection reason from review detail
  let rejectionReason: string | null = null;
  if (ourStatus === 'rejected') {
    try {
      const detailUrl = `${ASC_BASE}/v1/appStoreVersions/${version.id}/appStoreReviewDetail`;
      const detailRes = await getGateway().fetch(detailUrl, { kind: 'app', upstream: 'asc' }, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (detailRes.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const detail = await detailRes.json().catch(() => null) as any;
        const reasons: string[] = detail?.data?.attributes?.contactEmail
          ? []
          : (detail?.data?.attributes?.rejectionReasons ?? []);
        rejectionReason = reasons.join('; ') || null;
      }
    } catch {
      // non-critical — rejection reason may not be available
    }
  }

  await setListingUpdateStatus(sql, update.id, ourStatus, rejectionReason, resolvedAt);

  if (isTerminal) {
    await insertChangeEvent(sql, update.tenantId, {
      appId: update.appId,
      country: 'us',
      eventType: 'listing_update_resolved',
      payload: {
        updateId: update.id,
        status: ourStatus,
        ...(rejectionReason ? { rejectionReason } : {}),
      },
    });

    if (ourStatus === 'approved') {
      try {
        await insertListingMonitor(sql, {
          tenantId: update.tenantId,
          appId: update.appId,
          listingUpdateId: update.id,
          approvedAt: new Date(),
        });
      } catch (e) {
        console.error(`[listing-update-check] failed to insert monitor for ${update.id}:`, e);
      }
    }
  }
}

export async function runListingUpdateCheck(sql: postgres.Sql): Promise<void> {
  const updates = await getInFlightListingUpdates(sql);
  for (const update of updates) {
    try {
      await checkOneUpdate(sql, update);
    } catch (e) {
      console.error(`[listing-update-check] error for update ${update.id}:`, e);
    }
  }
}
