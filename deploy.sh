#!/usr/bin/env bash
# Upload the website to S3 and refresh CloudFront.
#
#   WEBSITE_BUCKET=video-stream-dev-website WEBSITE_DISTRIBUTION_ID=E123ABC ./deploy.sh
#
# Both values are printed by `terraform output` in the backend repository (website_bucket,
# website_distribution_id). Needs the AWS CLI, signed in to the account.
set -euo pipefail

: "${WEBSITE_BUCKET:?Set WEBSITE_BUCKET (terraform output website_bucket)}"
: "${WEBSITE_DISTRIBUTION_ID:?Set WEBSITE_DISTRIBUTION_ID (terraform output website_distribution_id)}"
REGION="${AWS_REGION:-ap-south-1}"
cd "$(dirname "$0")"

# The page itself is always re-checked, so a deploy shows up at once
aws s3 cp index.html "s3://$WEBSITE_BUCKET/index.html" --region "$REGION" \
  --content-type "text/html; charset=utf-8" --cache-control "no-cache"

# Scripts and styles keep their names between deploys: cache briefly, and refresh CloudFront below
aws s3 cp home.js  "s3://$WEBSITE_BUCKET/home.js"  --region "$REGION" --content-type "text/javascript; charset=utf-8" --cache-control "max-age=300"
aws s3 cp home.css "s3://$WEBSITE_BUCKET/home.css" --region "$REGION" --content-type "text/css; charset=utf-8"        --cache-control "max-age=300"
aws s3 cp shared/common.js "s3://$WEBSITE_BUCKET/shared/common.js" --region "$REGION" --content-type "text/javascript; charset=utf-8" --cache-control "max-age=300"

aws cloudfront create-invalidation --distribution-id "$WEBSITE_DISTRIBUTION_ID" --paths "/*" \
  --query "Invalidation.Id" --output text
echo "Deployed. Changes are live within a minute or two."
