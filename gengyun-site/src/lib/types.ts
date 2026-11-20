export type AnalysisRow = { label: string; value: string };

export type SampleRecord = {
  readRows: { label: string; value: string }[];
  correctedRows: { label: string; value: string }[];
  diffRows: { label: string; raw: string; corrected: string; changed: boolean }[];
  missingReadLabels: string;
  missingDiffLabels: string;
  correctedDiffers: boolean;
  analysis: {
    title: string;
    basisLabel: string;
    summary: string;
    rows: AnalysisRow[];
    boundaryNote: string;
  };
  fields: {
    registration_number: string | null;
    name: string;
    dosage_form: string;
    ingredients: { name: string; content_text: string; unit_text: string }[];
  };
  canCorrect: boolean;
  needsExplicitReview: boolean;
  matchState: string;
  matchLabel: string;
  conflictLabels: string[];
  missingFields: string[];
  doseCardCount: number;
  doseBlocked: boolean;
  doseBlockReason: string;
  authorityNote: string;
  readOnlyNote: string;
  correctionNote: string;
  doseNote: string;
  sourceVersion: string;
};

export type SampleLabel = {
  capturedAt: string;
  mode: string;
  note: string;
  state: string;
  stateTitle: string;
  record: SampleRecord;
};

export type AtlasHerbicide = {
  name: string;
  aliases: string;
  hazardLevel: string;
  hazardDetail: string;
  targetWeeds: string;
  regions: string;
};

export type AtlasWeed = { name: string; identifyKey: string };

export type AtlasRecord = {
  registrationNumber: string;
  name: string;
  producer: string;
  dosageForm: string;
  toxicity: string;
  pesticideClass: string;
  ingredients: string;
  useScene: string;
  target: string;
  recordStatus: string;
  reviewStatus: string;
  publisher: string;
  issue: string;
  publishedAt: string;
};

export type ControlTimingEntry = {
  crop: string;
  window: string;
  weeds: string;
};

export type ProvinceEntry = {
  province: string;
  region: string;
  count: string;
  weeds: string;
  crops: string;
};

export type AtlasData = {
  notice: string;
  sourceNotice: string;
  retrievedAt: string;
  herbicides: AtlasHerbicide[];
  weeds: AtlasWeed[];
  records: AtlasRecord[];
};
