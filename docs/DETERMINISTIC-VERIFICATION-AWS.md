# Deterministic Verification on AWS

This is the minimal production boundary for the deployment-neutral 0.2 core.
AWS is an adapter choice, not a dependency of the verification state machine.

## Topology

- API and Worker run in private ECS/Fargate services.
- RDS PostgreSQL owns Runs, checks, exact-cursor events, checkpoints, outbox,
  leases, and fencing.
- SQS is at-least-once transport; PostgreSQL fencing and semantic checkpoints
  own execution safety.
- S3 stores exact source objects, bounded artifacts, and Evidence under
  tenant-hashed prefixes.
- Each Verification Run gets a separate Fargate sandbox task with private,
  task-scoped `/workspace` and `/tmp` volumes.
- The Worker is the only caller allowed to reach sandbox TCP 8081. The sandbox
  has no task role, no ECS Exec, no host mount, no Docker socket, no public IP,
  and no access to RDS, S3, SQS, another workspace, or EC2 IMDS.

Mirror the Release's remote sandbox manifest into ECR without changing the OCI
manifest bytes, then verify the destination manifest digest is identical. This
allows private ECR/S3 VPC endpoints and avoids runtime Internet egress. The
server-owned task-definition map binds the public profile digest to that exact
task definition.

## Sandbox task definition

Use
[fargate-sandbox-task-definition.json](../examples/verification/aws/fargate-sandbox-task-definition.json)
as the minimal shape. Replace only the account, Region, log group, secret ARN,
and exact Release digest. The task definition:

- has an execution role but no task role;
- sets `readonlyRootFilesystem=true`, drops every Linux capability, and leaves
  ECS Exec disabled;
- mounts task-private writable volumes only at `/workspace` and `/tmp`;
- injects `REEF_VERIFICATION_SANDBOX_SHARED_SECRET` from Secrets Manager;
- starts the image's supported `sandbox-runner.js` default command on port 8081.

The same secret is injected into the Worker as
`REEF_VERIFICATION_ECS_RUNNER_SHARED_SECRET`. The adapter derives a per-run HMAC
token from runRef, attempt, and profile image digest. Profiles cannot supply or
override that token.

Set the Worker task-definition map to an immutable deployment-owned file:

```json
{
  "sha256:<remote-sandbox-manifest-digest>": "arn:aws:ecs:ap-southeast-2:123456789012:task-definition/reef-verification-sandbox:7"
}
```

## Network policy

- API security group: inbound HTTPS only from the service load balancer;
  outbound PostgreSQL to the RDS security group and SQS/S3 endpoints.
- Worker security group: no inbound; outbound PostgreSQL, SQS/S3/Secrets
  Manager/ECS endpoints and sandbox TCP 8081.
- Sandbox security group: inbound TCP 8081 only from the Worker security group;
  no broad outbound rule.
- Use private subnets with `assignPublicIp=DISABLED`.
- Do not attach a task role to the sandbox. Keep
  `AWS_EC2_METADATA_DISABLED=true`; Fargate does not expose EC2 instance IMDS
  to the task.

The Worker streams exact verified source bytes into the bridge. The sandbox
never receives S3 credentials or a presigned URL.

## Minimum Worker task-role permissions

Scope resources to one environment and tenant prefix:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "VerificationQueue",
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:ChangeMessageVisibility",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:ap-southeast-2:123456789012:reef-verification"
    },
    {
      "Sid": "VerificationObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::reef-verification/reef-verification/*"
    },
    {
      "Sid": "ProfileSecretsOnly",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:reef/verification/profile/*"
    },
    {
      "Sid": "SandboxLifecycle",
      "Effect": "Allow",
      "Action": [
        "ecs:RunTask",
        "ecs:DescribeTasks",
        "ecs:StopTask",
        "ecs:TagResource"
      ],
      "Resource": [
        "arn:aws:ecs:ap-southeast-2:123456789012:task-definition/reef-verification-sandbox:*",
        "arn:aws:ecs:ap-southeast-2:123456789012:task/*"
      ]
    },
    {
      "Sid": "PassSandboxExecutionRoleOnly",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::123456789012:role/reef-verification-sandbox-execution",
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": "ecs-tasks.amazonaws.com"
        }
      }
    }
  ]
}
```

API needs RDS connectivity plus SQS send and its tenant-scoped S3/Evidence
operations. The sandbox execution role needs only ECR pull, CloudWatch Logs,
and access to the one runner shared-secret ARN. It is not exposed to the
container as a task role.

## Rollout

1. Run the published `reef-verification migrate` image command.
2. Deploy API and wait for `/health/ready`.
3. Register the exact trusted profile JSON from the GitHub Release.
4. Deploy Worker with SQS, S3, Secrets Manager, and ECS adapters.
5. Submit a non-production immutable bundle and verify its event cursor,
   artifact/test/Evidence refs, and sandbox task termination.

The release gates exercise real PostgreSQL 16/17 and the isolated Docker
equivalent. A live customer AWS account deployment remains an environment
owner responsibility and is listed as unverified until separately exercised.
