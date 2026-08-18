declare global {
  namespace App {
    interface Locals {
      auth: import('$lib/server/auth/session').AuthContext | null;
      accessToken: string | null;
    }
    interface PageData {
      auth?: { userId: string; walletAddress: string } | null;
    }
  }
}

export {};
