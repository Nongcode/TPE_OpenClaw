BEGIN;

INSERT INTO "AgentTemplates" (
  "code",
  "name",
  "roleType",
  "systemPrompt",
  "toolsConfig",
  "routingPolicy",
  "status"
)
VALUES
  (
    'tpl_pho_phong',
    'Pho phong marketing',
    'manager',
    'Legacy default manager template mapped from pho_phong.',
    '{}'::jsonb,
    '{"legacyAgentId":"pho_phong"}'::jsonb,
    'active'
  ),
  (
    'tpl_nv_content',
    'Nhan vien content',
    'worker',
    'Legacy default worker template mapped from nv_content.',
    '{}'::jsonb,
    '{"legacyAgentId":"nv_content"}'::jsonb,
    'active'
  ),
  (
    'tpl_nv_media',
    'Nhan vien media',
    'worker',
    'Legacy default worker template mapped from nv_media.',
    '{}'::jsonb,
    '{"legacyAgentId":"nv_media"}'::jsonb,
    'active'
  ),
  (
    'tpl_nv_prompt',
    'Nhan vien prompt',
    'worker',
    'Legacy default worker template mapped from nv_prompt.',
    '{}'::jsonb,
    '{"legacyAgentId":"nv_prompt"}'::jsonb,
    'active'
  )
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "AgentInstances" (
  "templateId",
  "instanceCode",
  "displayName",
  "instanceType",
  "ownerCompanyId",
  "status",
  "configJson"
)
SELECT
  template."id",
  'mgr_pho_phong_A',
  'Pho phong A',
  'manager',
  NULL,
  'active',
  '{"legacyAgentId":"pho_phong","seedSource":"gp3-04"}'::jsonb
FROM "AgentTemplates" template
WHERE template."code" = 'tpl_pho_phong'
ON CONFLICT ("instanceCode") DO NOTHING;

INSERT INTO "AgentInstances" (
  "templateId",
  "instanceCode",
  "displayName",
  "instanceType",
  "ownerCompanyId",
  "status",
  "configJson"
)
SELECT
  template."id",
  'mgr_pho_phong_B',
  'Pho phong B',
  'manager',
  NULL,
  'active',
  '{"legacyAgentId":"pho_phong","seedSource":"gp3-04"}'::jsonb
FROM "AgentTemplates" template
WHERE template."code" = 'tpl_pho_phong'
ON CONFLICT ("instanceCode") DO NOTHING;

INSERT INTO "ManagerWorkerBindings" (
  "managerInstanceId",
  "workerTemplateId",
  "workerRoleCode",
  "isEnabled",
  "priority"
)
SELECT
  manager_instance."id",
  worker_template."id",
  NULL,
  true,
  binding.priority
FROM (
  VALUES
    ('tpl_nv_content', 100),
    ('tpl_nv_media', 200),
    ('tpl_nv_prompt', 300)
) AS binding("workerTemplateCode", "priority")
JOIN "AgentInstances" manager_instance
  ON manager_instance."instanceCode" IN ('mgr_pho_phong_A', 'mgr_pho_phong_B')
JOIN "AgentTemplates" worker_template
  ON worker_template."code" = binding."workerTemplateCode"
WHERE NOT EXISTS (
  SELECT 1
  FROM "ManagerWorkerBindings" existing
  WHERE existing."managerInstanceId" = manager_instance."id"
    AND existing."workerTemplateId" = worker_template."id"
);

COMMIT;
