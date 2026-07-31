// ============================================================
// Meta Graph API — fetch a lead's answers by leadgen_id.
//
// The `leadgen` webhook only carries ids (leadgen_id, form_id, ad_id,
// page_id). The actual field answers must be fetched from the Graph API
// with the Page's access token:
//
//   GET /{leadgen_id}?access_token=<page_token>
//   → { id, created_time, field_data: [{ name, values: [...] }, ...],
//       ad_id?, form_id?, campaign_name?, ... }
// ============================================================

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

export interface LeadFieldDatum {
  name: string;
  values: string[];
}

export interface MetaLeadDetail {
  id: string;
  created_time?: string;
  field_data: LeadFieldDatum[];
  ad_id?: string;
  ad_name?: string;
  form_id?: string;
  campaign_id?: string;
  campaign_name?: string;
}

/**
 * Fetch a lead's full detail from the Graph API. Throws on a non-OK
 * response (the caller logs and returns a 200 to Meta regardless, so a
 * bad token doesn't cause endless retries).
 */
export async function fetchLeadDetail(
  leadgenId: string,
  pageAccessToken: string
): Promise<MetaLeadDetail> {
  const fields =
    'id,created_time,field_data,ad_id,ad_name,form_id,campaign_id,campaign_name';
  const url = `${META_API_BASE}/${leadgenId}?fields=${fields}&access_token=${encodeURIComponent(
    pageAccessToken
  )}`;

  const response = await fetch(url);
  if (!response.ok) {
    let message = `Graph API error: ${response.status}`;
    try {
      const data = (await response.json()) as {
        error?: { message?: string };
      };
      if (data.error?.message) message = data.error.message;
    } catch {
      // body wasn't JSON — keep the status fallback
    }
    throw new Error(message);
  }
  return response.json() as Promise<MetaLeadDetail>;
}
