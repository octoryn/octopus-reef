# Control Plane on AWS: minimum production wiring

Use the exact API, Worker and sandbox `sha256:` digests from the matching
GitHub Release. The GHCR packages are public; do not put registry credentials in
an ECS task definition. Mirror the same digest into private ECR when sandbox
tasks must start without Internet/NAT access.

## RDS TLS

All three official images contain the AWS RDS global CA bundle at:

```text
/etc/ssl/certs/aws-rds-global-bundle.pem
```

The release build downloads the AWS trust-store object and refuses to build
unless its SHA-256 is exactly:

```text
e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3
```

Set only:

```text
REEF_CONTROL_PLANE_DATABASE_SSL_MODE=verify-full
```

The API and Worker then use the fixed bundle automatically. An explicit CA file
or base64 value remains an override for non-RDS PostgreSQL deployments.

## Fargate sandbox runner

The supported sandbox image runs one authenticated command endpoint per
Fargate task on port `8081`. The Worker discovers the task's private IPv4 address
with `ecs:DescribeTasks`; no central command bridge, ECS Exec, SSM session, or
`REEF_ECS_COMMAND_ENDPOINT` is required.

Start from
`examples/control-plane/aws/sandbox-task-definition.json`, replace its account,
region, execution role and immutable release digest, and register it with ECS.
Choose `ARM64` instead of `X86_64` when the surrounding Fargate service uses the
arm64 manifest.

Worker configuration:

```text
REEF_SANDBOX_ADAPTER=ecs
REEF_ECS_CLUSTER=<cluster arn>
REEF_ECS_TASK_DEFINITION=<sandbox task definition arn>
REEF_ECS_SUBNETS=<private subnet ids, comma separated>
REEF_ECS_SECURITY_GROUPS=<sandbox security group ids, comma separated>
REEF_ECS_CONTAINER_NAME=agent
REEF_ECS_RUNNER_SHARED_SECRET=<worker-only secret, injected by ECS Secrets>
REEF_ECS_RUNNER_PORT=8081
REEF_ECS_RUNNER_WORKSPACE=/workspace
REEF_GIT_ENABLED=false
```

The Worker derives a stable per-run/per-attempt HMAC token and passes only that
derived token to the sandbox task. The runner executes one command at a time,
uses shell-free process spawning, bounds request/output/time, confines `cwd` to
`/workspace`, and starts children with a minimal environment. AWS credential,
Reef-internal, loader and Node option variables are removed; EC2 IMDS is
disabled. The legacy external endpoint remains available only when
`REEF_ECS_COMMAND_ENDPOINT` is explicitly set.

For strict customer-code isolation, give the sandbox task **no task role** and
do not mount a shared workspace parent. Use task-ephemeral `/workspace`, or an
EFS access point whose root exposes only this deployment's isolated workspace.
The reference runner does not require host mounts, the Docker socket, privileged
mode, ECS Exec, or Linux capabilities.

The sandbox security group should accept TCP/8081 only from the Worker security
group. Runtime egress should be empty. For Fargate image startup without broad
egress, mirror the published immutable sandbox digest into ECR and use ECR API,
ECR DKR, CloudWatch Logs and S3 VPC endpoints. Do not give customer code a NAT
route merely to pull GHCR.

## Bedrock IAM

Set `REEF_MODEL_PROVIDER=bedrock-iam` and optionally `AWS_REGION` plus the
opaque Run config field `model`. Do not send a `bedrockToken` secretRef. The
shared `@octopus-reef/agent` `BedrockIamProvider` uses the AWS SDK default
credential chain and SigV4, which resolves the Worker Fargate task role.

Minimum model statement (narrow resources to the chosen model/inference
profile):

```json
{
  "Effect": "Allow",
  "Action": ["bedrock:InvokeModel"],
  "Resource": [
    "arn:aws:bedrock:REGION:ACCOUNT:inference-profile/PROFILE_ID",
    "arn:aws:bedrock:REGION::foundation-model/MODEL_ID"
  ]
}
```

Add `bedrock:InvokeModelWithResponseStream` only if a future provider actually
uses streaming.

## Worker task-role minimums

Scope every resource ARN to the deployment, tenant prefix and sandbox task
family. Omit unused adapter sections.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "RunSandboxTasks",
      "Effect": "Allow",
      "Action": [
        "ecs:RunTask",
        "ecs:DescribeTasks",
        "ecs:StopTask",
        "ecs:TagResource"
      ],
      "Resource": [
        "arn:aws:ecs:REGION:ACCOUNT:task-definition/REEF_SANDBOX_FAMILY:*",
        "arn:aws:ecs:REGION:ACCOUNT:task/CLUSTER/*"
      ]
    },
    {
      "Sid": "PassSandboxExecutionRole",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::ACCOUNT:role/REEF_SANDBOX_EXECUTION_ROLE",
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": "ecs-tasks.amazonaws.com"
        }
      }
    },
    {
      "Sid": "Queue",
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:ChangeMessageVisibility",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:REGION:ACCOUNT:REEF_QUEUE"
    },
    {
      "Sid": "RunSecrets",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:REGION:ACCOUNT:secret:reef/*"
    },
    {
      "Sid": "Artifacts",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::REEF_ARTIFACT_BUCKET/reef-runs/*"
    }
  ]
}
```

If S3 uses a customer-managed KMS key, add only `kms:Encrypt`, `kms:Decrypt`
and `kms:GenerateDataKey` on that key. RDS password retrieval belongs on the API
and Worker task roles; the sandbox task role remains absent. Database network
access is limited to the API/Worker security groups and is never granted to the
sandbox security group.

## Execution-role minimums

The API/Worker/sandbox ECS **execution** roles are separate from task roles.
They need the usual `logs:CreateLogStream`/`logs:PutLogEvents`, plus
`secretsmanager:GetSecretValue` and `kms:Decrypt` only for secrets referenced by
the task definition. Pulling the public GHCR images does not grant the container
AWS permissions. When mirrored to ECR, add the standard read-only ECR pull
actions to the execution role, not the sandbox task role.
