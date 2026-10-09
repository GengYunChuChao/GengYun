declare module '*packages/privacy/guard.mjs' {
  export function createPrivacyGuard(deps: {
    account: { stateOf(userId: string): Promise<string>; authEpochOf(userId: string): Promise<number> };
    consentStore: {
      isGranted(input: { userId: string; purpose: string }): Promise<boolean>;
      currentEpoch(input: { userId: string; purpose: string }): Promise<number>;
    };
  }): {
    assertAccountActive(userId: string, options: { authEpoch: number }): Promise<void>;
    requireConsent(input: { purpose: string; dataType?: string }):
      (identity: { userId: string; authEpoch: number }) => Promise<{ userId: string; purpose: string; consentEpoch: number }>;
  };
}
