## Manifest Fields

Each agent manifest is a JSON object.

Required:

- `id`

Recommended:

- `label`
- `role`
- `reportsTo`
- `canDelegateTo`
- `capabilities`
- `taskTypes`
- `requiresReviewBy`
- `transport`

Example:

```json
{
  "id": "pho_phong",
  "label": "Pho phong",
  "role": "dispatcher",
  "reportsTo": "truong_phong",
  "canDelegateTo": ["nv_content", "nv_media"],
  "capabilities": ["workflow", "cross-check", "coordination"],
  "taskTypes": ["campaign.plan", "campaign.execute"],
  "requiresReviewBy": "truong_phong"
}
```

Notes:

- `transport.sessionKey` can override auto-discovered session keys.
- `canDelegateTo` is authoritative for routing.
- `reportsTo` is used for escalation and review chains.
