-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "RepositoryPermission" AS ENUM ('READ', 'TRIAGE', 'WRITE', 'MAINTAIN', 'ADMIN');

-- CreateEnum
CREATE TYPE "PullRequestState" AS ENUM ('OPEN', 'CLOSED', 'MERGED');

-- CreateEnum
CREATE TYPE "ReviewRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'AWAITING_APPROVAL');

-- CreateEnum
CREATE TYPE "ReviewTrigger" AS ENUM ('WEBHOOK', 'MANUAL', 'RETRY');

-- CreateEnum
CREATE TYPE "ReviewVerdict" AS ENUM ('PASSED', 'NEUTRAL', 'FAILED');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateEnum
CREATE TYPE "FindingCategory" AS ENUM ('BUG', 'SECURITY', 'PERFORMANCE', 'ARCHITECTURE', 'MAINTAINABILITY', 'TESTING', 'STYLE');

-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('DRAFT', 'VALIDATED', 'PUBLISHED', 'DISMISSED', 'RESOLVED', 'STALE', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "FindingSource" AS ENUM ('AGENT', 'STATIC_ANALYSIS', 'SECURITY_SCAN', 'TEST_EXECUTION', 'HUMAN');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "ExecutionKind" AS ENUM ('TEST', 'LINT', 'TYPECHECK', 'BUILD', 'STATIC_ANALYSIS', 'SECURITY_SCAN');

-- CreateEnum
CREATE TYPE "SandboxKind" AS ENUM ('DOCKER', 'PROCESS');

-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'MEMBER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL,
    "githubId" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "installationId" TEXT,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "isPrivate" BOOLEAN NOT NULL DEFAULT true,
    "language" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepositoryAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "permission" "RepositoryPermission" NOT NULL DEFAULT 'READ',
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedById" TEXT,

    CONSTRAINT "RepositoryAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullRequest" (
    "id" TEXT NOT NULL,
    "githubId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "author" TEXT NOT NULL,
    "state" "PullRequestState" NOT NULL DEFAULT 'OPEN',
    "draft" BOOLEAN NOT NULL DEFAULT false,
    "baseRef" TEXT NOT NULL,
    "baseSha" TEXT NOT NULL,
    "headRef" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "additions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "changedFiles" INTEGER NOT NULL DEFAULT 0,
    "url" TEXT NOT NULL,
    "labels" JSONB NOT NULL DEFAULT '[]',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mergedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PullRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewRun" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "status" "ReviewRunStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" "ReviewTrigger" NOT NULL DEFAULT 'WEBHOOK',
    "verdict" "ReviewVerdict",
    "headSha" TEXT NOT NULL,
    "baseSha" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "summary" TEXT,
    "plan" JSONB,
    "planReasons" JSONB,
    "changedFiles" JSONB,
    "diff" TEXT,
    "filesAnalyzed" INTEGER NOT NULL DEFAULT 0,
    "findingsTotal" INTEGER NOT NULL DEFAULT 0,
    "criticalCount" INTEGER NOT NULL DEFAULT 0,
    "highCount" INTEGER NOT NULL DEFAULT 0,
    "mediumCount" INTEGER NOT NULL DEFAULT 0,
    "lowCount" INTEGER NOT NULL DEFAULT 0,
    "infoCount" INTEGER NOT NULL DEFAULT 0,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "iterations" INTEGER NOT NULL DEFAULT 0,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "commentId" TEXT,
    "checkRunId" TEXT,
    "error" TEXT,
    "budgetLimit" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewFinding" (
    "id" TEXT NOT NULL,
    "reviewRunId" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "category" "FindingCategory" NOT NULL,
    "status" "FindingStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "file" TEXT NOT NULL,
    "line" INTEGER,
    "endLine" INTEGER,
    "suggestion" TEXT,
    "evidence" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "confidenceBand" TEXT NOT NULL,
    "publishable" BOOLEAN NOT NULL DEFAULT false,
    "source" "FindingSource" NOT NULL DEFAULT 'AGENT',
    "ruleId" TEXT,
    "validationReasons" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB,
    "githubCommentId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentExecution" (
    "id" TEXT NOT NULL,
    "reviewRunId" TEXT NOT NULL,
    "graphName" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'RUNNING',
    "currentNode" TEXT,
    "iterations" INTEGER NOT NULL DEFAULT 0,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "AgentExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentNodeExecution" (
    "id" TEXT NOT NULL,
    "reviewRunId" TEXT NOT NULL,
    "agentExecutionId" TEXT NOT NULL,
    "node" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'RUNNING',
    "summary" TEXT,
    "inputMetadata" JSONB,
    "outputMetadata" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "AgentNodeExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolExecution" (
    "id" TEXT NOT NULL,
    "reviewRunId" TEXT NOT NULL,
    "agentExecutionId" TEXT,
    "tool" TEXT NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'RUNNING',
    "inputMetadata" JSONB,
    "outputMetadata" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,

    CONSTRAINT "ToolExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestExecution" (
    "id" TEXT NOT NULL,
    "reviewRunId" TEXT NOT NULL,
    "kind" "ExecutionKind" NOT NULL,
    "tool" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "exitCode" INTEGER,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "stdout" TEXT,
    "stderr" TEXT,
    "timedOut" BOOLEAN NOT NULL DEFAULT false,
    "sandbox" "SandboxKind" NOT NULL DEFAULT 'DOCKER',
    "image" TEXT,
    "summary" TEXT,
    "details" JSONB,
    "skippedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "action" TEXT,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "repositoryId" TEXT,
    "repositoryFullName" TEXT,
    "installationId" TEXT,
    "pullRequestNumber" INTEGER,
    "headSha" TEXT,
    "reviewRunId" TEXT,
    "payloadSummary" JSONB,
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewApproval" (
    "id" TEXT NOT NULL,
    "reviewRunId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "reason" TEXT,

    CONSTRAINT "ReviewApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_isActive_idx" ON "User"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_githubId_key" ON "Repository"("githubId");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_fullName_key" ON "Repository"("fullName");

-- CreateIndex
CREATE INDEX "Repository_installationId_idx" ON "Repository"("installationId");

-- CreateIndex
CREATE INDEX "Repository_isActive_idx" ON "Repository"("isActive");

-- CreateIndex
CREATE INDEX "Repository_owner_name_idx" ON "Repository"("owner", "name");

-- CreateIndex
CREATE INDEX "RepositoryAccess_repositoryId_idx" ON "RepositoryAccess"("repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryAccess_userId_repositoryId_key" ON "RepositoryAccess"("userId", "repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequest_githubId_key" ON "PullRequest"("githubId");

-- CreateIndex
CREATE INDEX "PullRequest_repositoryId_state_idx" ON "PullRequest"("repositoryId", "state");

-- CreateIndex
CREATE INDEX "PullRequest_headSha_idx" ON "PullRequest"("headSha");

-- CreateIndex
CREATE INDEX "PullRequest_updatedAt_idx" ON "PullRequest"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequest_repositoryId_number_key" ON "PullRequest"("repositoryId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewRun_idempotencyKey_key" ON "ReviewRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ReviewRun_repositoryId_createdAt_idx" ON "ReviewRun"("repositoryId", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewRun_pullRequestId_createdAt_idx" ON "ReviewRun"("pullRequestId", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewRun_status_createdAt_idx" ON "ReviewRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewRun_headSha_idx" ON "ReviewRun"("headSha");

-- CreateIndex
CREATE INDEX "ReviewRun_trigger_idx" ON "ReviewRun"("trigger");

-- CreateIndex
CREATE INDEX "ReviewFinding_pullRequestId_status_idx" ON "ReviewFinding"("pullRequestId", "status");

-- CreateIndex
CREATE INDEX "ReviewFinding_reviewRunId_severity_idx" ON "ReviewFinding"("reviewRunId", "severity");

-- CreateIndex
CREATE INDEX "ReviewFinding_fingerprint_idx" ON "ReviewFinding"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewFinding_reviewRunId_fingerprint_key" ON "ReviewFinding"("reviewRunId", "fingerprint");

-- CreateIndex
CREATE INDEX "AgentExecution_reviewRunId_startedAt_idx" ON "AgentExecution"("reviewRunId", "startedAt");

-- CreateIndex
CREATE INDEX "AgentExecution_status_idx" ON "AgentExecution"("status");

-- CreateIndex
CREATE INDEX "AgentNodeExecution_agentExecutionId_startedAt_idx" ON "AgentNodeExecution"("agentExecutionId", "startedAt");

-- CreateIndex
CREATE INDEX "AgentNodeExecution_reviewRunId_node_idx" ON "AgentNodeExecution"("reviewRunId", "node");

-- CreateIndex
CREATE INDEX "ToolExecution_reviewRunId_startedAt_idx" ON "ToolExecution"("reviewRunId", "startedAt");

-- CreateIndex
CREATE INDEX "ToolExecution_tool_idx" ON "ToolExecution"("tool");

-- CreateIndex
CREATE INDEX "TestExecution_reviewRunId_kind_idx" ON "TestExecution"("reviewRunId", "kind");

-- CreateIndex
CREATE INDEX "TestExecution_status_idx" ON "TestExecution"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_deliveryId_key" ON "WebhookEvent"("deliveryId");

-- CreateIndex
CREATE INDEX "WebhookEvent_event_action_idx" ON "WebhookEvent"("event", "action");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_receivedAt_idx" ON "WebhookEvent"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_repositoryFullName_idx" ON "WebhookEvent"("repositoryFullName");

-- CreateIndex
CREATE INDEX "ReviewApproval_reviewRunId_status_idx" ON "ReviewApproval"("reviewRunId", "status");

-- CreateIndex
CREATE INDEX "ReviewApproval_status_requestedAt_idx" ON "ReviewApproval"("status", "requestedAt");

-- AddForeignKey
ALTER TABLE "RepositoryAccess" ADD CONSTRAINT "RepositoryAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryAccess" ADD CONSTRAINT "RepositoryAccess_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRun" ADD CONSTRAINT "ReviewRun_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRun" ADD CONSTRAINT "ReviewRun_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewFinding" ADD CONSTRAINT "ReviewFinding_reviewRunId_fkey" FOREIGN KEY ("reviewRunId") REFERENCES "ReviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewFinding" ADD CONSTRAINT "ReviewFinding_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentExecution" ADD CONSTRAINT "AgentExecution_reviewRunId_fkey" FOREIGN KEY ("reviewRunId") REFERENCES "ReviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentNodeExecution" ADD CONSTRAINT "AgentNodeExecution_reviewRunId_fkey" FOREIGN KEY ("reviewRunId") REFERENCES "ReviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentNodeExecution" ADD CONSTRAINT "AgentNodeExecution_agentExecutionId_fkey" FOREIGN KEY ("agentExecutionId") REFERENCES "AgentExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_reviewRunId_fkey" FOREIGN KEY ("reviewRunId") REFERENCES "ReviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolExecution" ADD CONSTRAINT "ToolExecution_agentExecutionId_fkey" FOREIGN KEY ("agentExecutionId") REFERENCES "AgentExecution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestExecution" ADD CONSTRAINT "TestExecution_reviewRunId_fkey" FOREIGN KEY ("reviewRunId") REFERENCES "ReviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewApproval" ADD CONSTRAINT "ReviewApproval_reviewRunId_fkey" FOREIGN KEY ("reviewRunId") REFERENCES "ReviewRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewApproval" ADD CONSTRAINT "ReviewApproval_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
