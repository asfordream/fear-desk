declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    FEISHU_WEBHOOK_URL?: string;
    FEISHU_SIGNING_SECRET?: string;
    FEISHU_SEND_ENABLED?: string;
    SITE_BASE_URL?: string;
    FINNHUB_API_KEY?: string;
  }
}
