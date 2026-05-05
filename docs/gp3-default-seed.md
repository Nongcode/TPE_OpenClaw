# GP3 Default Seed

## Scope

- PR nay seed du lieu mac dinh de map he hien tai sang GP3.
- Chua doi runtime sang schema moi.
- Muc tieu la coi `pho_phong` hien tai nhu manager instance mac dinh dau tien.

## Du lieu duoc tao

### Agent templates

- `tpl_pho_phong`
- `tpl_nv_content`
- `tpl_nv_media`
- `tpl_nv_prompt`

### Agent instance

- `mgr_pho_phong_A`
  - map voi template `tpl_pho_phong`
  - `configJson` co `legacyAgentId: "pho_phong"`

### Manager worker bindings

- `mgr_pho_phong_A` -> `tpl_nv_content`
- `mgr_pho_phong_A` -> `tpl_nv_media`
- `mgr_pho_phong_A` -> `tpl_nv_prompt`

## Tinh chat idempotent

- Template seed dung `ON CONFLICT ("code") DO NOTHING`
- Instance seed dung `ON CONFLICT ("instanceCode") DO NOTHING`
- Binding seed dung `WHERE NOT EXISTS`

Co the chay nhieu lan an toan ma khong tao ban ghi trung.

## File

- Migration SQL: `backend/migrations/20260504_gp3_orchestrator_default_seed.sql`
- Verify script: `scripts/verify-gp3-orchestrator-default-seed.mjs`

## Cach test nhanh

Verify trong schema tam:

```bash
node scripts/verify-gp3-orchestrator-default-seed.mjs
```

Neu can apply thu cong:

```bash
psql -d openclaw -f backend/migrations/20260504_gp3_orchestrator_foundation.sql
psql -d openclaw -f backend/migrations/20260504_gp3_orchestrator_default_seed.sql
```
