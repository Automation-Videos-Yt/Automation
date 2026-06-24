/*
  Warnings:

  - A unique constraint covering the columns `[razorpayCustomerId]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('PURCHASE', 'VIDEO_GENERATION', 'REFUND', 'ADMIN');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('STRIPE', 'RAZORPAY');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- AlterTable
ALTER TABLE "PipelineRun" ADD COLUMN     "creditsCharged" INTEGER,
ADD COLUMN     "creditsRefunded" INTEGER,
ADD COLUMN     "pricingSnapshot" JSONB,
ADD COLUMN     "refundProcessed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "refundReason" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "razorpayCustomerId" TEXT,
ALTER COLUMN "credits" SET DEFAULT 50;

-- CreateTable
CREATE TABLE "CreditPackage" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "priceInr" INTEGER NOT NULL,
    "priceUsd" INTEGER,
    "stripePriceId" TEXT,
    "razorpayPlanId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "type" "TransactionType" NOT NULL,
    "referenceId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerPaymentId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "creditsGranted" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Payment_providerPaymentId_key" ON "Payment"("providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "User_razorpayCustomerId_key" ON "User"("razorpayCustomerId");
