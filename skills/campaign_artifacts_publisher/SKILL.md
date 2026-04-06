---
name: campaign-artifacts-publisher
description: Read completed campaign artifacts from `artifacts/` and execute the downstream commercial flow: reuse product profile and content output, send original product images together with image/video prompts to Gemini, then prepare or publish image/video posts to the target Facebook page. Use when an upstream agent already wrote `products`, `content`, or `campaigns/summary.json` artifacts and Codex must continue from those saved results instead of regenerating everything manually.
---

# Skill `campaign_artifacts_publisher`

Continue a completed or partially completed campaign bundle stored in `artifacts/`.

## Inputs

- `campaign_summary_path` (optional): explicit `artifacts/campaigns/**/summary.json`
- `campaign_dir` (optional): campaign folder; the skill will look for `summary.json` inside it
- `content_artifact_path` (optional): explicit `artifacts/content/*.json`
- `product_artifact_path` (optional): explicit `artifacts/products/*.json`
- `image_paths` (optional): extra original product images to upload as references
- `facebook_publish_mode` (optional): `confirm_only` or `publish_now`
- `publish_image_post` (optional)
- `publish_video_post` (optional)
- `allow_text_only_fallback` (optional)
- `dry_run` (optional)

If no source artifact path is provided, the skill auto-discovers the latest usable bundle under `artifacts/campaigns`, then `artifacts/content`, then `artifacts/products`.

## Flow

1. Resolve source artifacts from `artifacts/`
2. Load `product_profile` and `sales_content`
3. Collect original product images from:
   - explicit `image_paths`
   - `product_profile.image_paths`
   - image files copied inside the selected campaign directory
4. Create image via `gemini_generate_image` with reference images uploaded
5. Create video via `generate_video` with reference images uploaded
6. Prepare or publish image/video posts via `facebook_publish_post`
7. Save a new `artifacts/campaigns/*/summary.json`

## Rules

- Prefer artifact data over manual re-entry.
- Treat original product images as source-of-truth references for both image and video generation.
- If an image is generated successfully, include that generated image as an extra reference for the video step unless disabled.
- Preserve every important path in the final summary so downstream agents can continue from the same bundle.
