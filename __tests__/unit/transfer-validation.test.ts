import { describe, it, expect } from "vitest";
import {
  validateSideShape,
  validateTransferSide,
} from "@/lib/actions/transfer-validation";
import type { TransferSide } from "@/lib/types";

const REAL_UUID_A = "11111111-1111-1111-1111-111111111111";
const REAL_UUID_B = "22222222-2222-2222-2222-222222222222";
const PENDING = "PENDING";

describe("validateSideShape (early, before entity creation)", () => {
  describe("crypto_position", () => {
    it("accepts positive quantity with PENDING UUIDs (the whole point)", () => {
      const side: TransferSide = {
        type: "crypto_position",
        assetId: PENDING,
        walletId: PENDING,
        quantity: 1.5,
      };
      expect(() => validateSideShape(side, "Destination")).not.toThrow();
    });

    it("rejects zero quantity", () => {
      const side: TransferSide = {
        type: "crypto_position",
        assetId: REAL_UUID_A,
        walletId: REAL_UUID_B,
        quantity: 0,
      };
      expect(() => validateSideShape(side, "Destination")).toThrow("must be positive");
    });

    it("rejects negative quantity", () => {
      const side: TransferSide = {
        type: "crypto_position",
        assetId: REAL_UUID_A,
        walletId: REAL_UUID_B,
        quantity: -10,
      };
      expect(() => validateSideShape(side, "Source")).toThrow(/Source/);
    });
  });

  describe("stock_position", () => {
    it("accepts positive quantity with PENDING UUIDs", () => {
      const side: TransferSide = {
        type: "stock_position",
        assetId: PENDING,
        brokerId: PENDING,
        quantity: 5,
      };
      expect(() => validateSideShape(side, "Destination")).not.toThrow();
    });

    it("rejects zero quantity", () => {
      const side: TransferSide = {
        type: "stock_position",
        assetId: REAL_UUID_A,
        brokerId: REAL_UUID_B,
        quantity: 0,
      };
      expect(() => validateSideShape(side, "Destination")).toThrow();
    });
  });

  describe("cash_account", () => {
    it("accepts positive amount with PENDING accountId", () => {
      const side: TransferSide = {
        type: "cash_account",
        accountId: PENDING,
        amount: 100.5,
      };
      expect(() => validateSideShape(side, "Source")).not.toThrow();
    });

    it("rejects zero amount", () => {
      const side: TransferSide = {
        type: "cash_account",
        accountId: REAL_UUID_A,
        amount: 0,
      };
      expect(() => validateSideShape(side, "Source")).toThrow("must be positive");
    });

    it("rejects negative amount", () => {
      const side: TransferSide = {
        type: "cash_account",
        accountId: REAL_UUID_A,
        amount: -50,
      };
      expect(() => validateSideShape(side, "Source")).toThrow();
    });
  });

  describe("label propagation", () => {
    it("uses 'Destination' label in error messages", () => {
      const side: TransferSide = {
        type: "stock_position",
        assetId: REAL_UUID_A,
        brokerId: REAL_UUID_B,
        quantity: 0,
      };
      expect(() => validateSideShape(side, "Destination")).toThrow(/Destination/);
    });

    it("uses 'Source' label in error messages", () => {
      const side: TransferSide = {
        type: "cash_account",
        accountId: REAL_UUID_A,
        amount: 0,
      };
      expect(() => validateSideShape(side, "Source")).toThrow(/Source/);
    });
  });
});

describe("validateTransferSide (late, after PENDING patching)", () => {
  describe("crypto_position", () => {
    it("accepts real UUIDs + valid quantity", () => {
      const side: TransferSide = {
        type: "crypto_position",
        assetId: REAL_UUID_A,
        walletId: REAL_UUID_B,
        quantity: 2,
      };
      expect(() => validateTransferSide(side, "Destination")).not.toThrow();
    });

    it("rejects PENDING assetId (would 500 the buy)", () => {
      const side: TransferSide = {
        type: "crypto_position",
        assetId: PENDING,
        walletId: REAL_UUID_B,
        quantity: 2,
      };
      expect(() => validateTransferSide(side, "Destination")).toThrow("Destination asset ID");
    });

    it("rejects PENDING walletId", () => {
      const side: TransferSide = {
        type: "crypto_position",
        assetId: REAL_UUID_A,
        walletId: PENDING,
        quantity: 2,
      };
      expect(() => validateTransferSide(side, "Destination")).toThrow("Destination wallet ID");
    });
  });

  describe("stock_position", () => {
    it("accepts real UUIDs + valid quantity", () => {
      const side: TransferSide = {
        type: "stock_position",
        assetId: REAL_UUID_A,
        brokerId: REAL_UUID_B,
        quantity: 10,
      };
      expect(() => validateTransferSide(side, "Destination")).not.toThrow();
    });

    it("rejects PENDING brokerId", () => {
      const side: TransferSide = {
        type: "stock_position",
        assetId: REAL_UUID_A,
        brokerId: PENDING,
        quantity: 10,
      };
      expect(() => validateTransferSide(side, "Destination")).toThrow("Destination broker ID");
    });
  });

  describe("cash_account", () => {
    it("accepts real accountId + positive amount", () => {
      const side: TransferSide = {
        type: "cash_account",
        accountId: REAL_UUID_A,
        amount: 100,
      };
      expect(() => validateTransferSide(side, "Source")).not.toThrow();
    });

    it("rejects PENDING accountId (the seed-cash flow's pre-patch state)", () => {
      const side: TransferSide = {
        type: "cash_account",
        accountId: PENDING,
        amount: 100,
      };
      expect(() => validateTransferSide(side, "Source")).toThrow("Source account ID");
    });
  });

  describe("shape errors fire before UUID errors", () => {
    it("zero quantity rejected even with invalid UUIDs (shape first)", () => {
      const side: TransferSide = {
        type: "stock_position",
        assetId: "not-a-uuid",
        brokerId: "not-a-uuid",
        quantity: 0,
      };
      expect(() => validateTransferSide(side, "Destination")).toThrow("must be positive");
    });
  });
});
