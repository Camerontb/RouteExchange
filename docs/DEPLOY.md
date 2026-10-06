# Deploying the EMPX gateway

The gateway is a **single always-on Cloud Run service** in `us-central1`,
project `mpx2-d9148`. It holds one aisstream WebSocket per AIS-enabled org and
writes targets into Firestore; a single-writer lease makes a brief deploy
overlap safe. Config lives in [`service.yaml`](../service.yaml); the build and
rollout live in [`cloudbuild.yaml`](../cloudbuild.yaml).

## One-time setup (owner runs once)

These need IAM privileges, so run them yourself. They are idempotent.

1. **Enable APIs:** `run`, `cloudbuild`, `artifactregistry`, `firestore`.
2. **Runtime service account** `empx-gateway@mpx2-d9148.iam.gserviceaccount.com`
   with **only** `roles/datastore.user` and `roles/logging.logWriter`. This is
   what the service runs as — deliberately not the default compute SA
   (`roles/editor`), because this process reads customers' AIS keys.
   `service.yaml` already names this SA.
3. **Artifact Registry** docker repo `empx-gateway` in `us-central1`.
4. **Let Cloud Build deploy:** grant the Cloud Build SA
   (`<projectNumber>@cloudbuild.gserviceaccount.com`) `roles/run.admin` on the
   project and `roles/iam.serviceAccountUser` on the runtime SA above.

The exact `gcloud` commands for steps 2–4 are the privileged ones; keep them in
your own runbook (the assistant is blocked from writing IAM grants).

## Releasing

Build is immutable and tagged with the git SHA, so rollback is a traffic flip,
not a rebuild.

**First deploy (before any trigger):**
```
gcloud builds submit --config cloudbuild.yaml \
  --substitutions=SHORT_SHA=$(git rev-parse --short HEAD) --project mpx2-d9148
```

**Ongoing — a git tag is the release gesture.** Connect the GitHub repo once
(Cloud Build console → Repositories, 2nd-gen connection for
`Camerontb/RouteExchange`), then create the trigger:
```
gcloud builds triggers create github \
  --name empx-gateway-release \
  --repo-owner Camerontb --repo-name RouteExchange \
  --tag-pattern '^v.*' \
  --build-config cloudbuild.yaml \
  --region us-central1 --project mpx2-d9148
```
After that a release is just:
```
git tag v1.0.0 && git push origin v1.0.0
```

**Rollback** to a previous revision (no rebuild):
```
gcloud run services update-traffic empx-mcp-gateway \
  --region us-central1 --to-revisions <REVISION>=100
```

## Verifying a deploy

- `gcloud run services describe empx-mcp-gateway --region us-central1` → Ready.
- Logs: `gcloud run services logs read empx-mcp-gateway --region us-central1`.
  Expect `[ais] <orgId> connected, N box(es)` for each enabled org.
- Per org, `orgs/{orgId}/config/aisStatus.state` should go `live`, and the
  Admin → AIS tab shows the vessel count. If a key is wrong it shows `error`.

## Secrets (before scaling to paying customers)

Per-org aisstream keys currently live in Firestore (`secrets/ais`,
read-protected by rules — only this service's Admin SDK reads them). Move them
to Secret Manager, mounted into the service, before onboarding paid orgs.
