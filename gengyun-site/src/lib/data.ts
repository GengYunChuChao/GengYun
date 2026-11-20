import atlasJson from "@/data/atlas.json";
import timingJson from "@/data/control-timing.json";
import provinceJson from "@/data/province-index.json";
import sampleJson from "@/data/sample-label.json";
import type {
  AtlasData,
  ControlTimingEntry,
  ProvinceEntry,
  SampleLabel,
} from "@/lib/types";

export const atlas = atlasJson as AtlasData;
export const controlTiming = timingJson as {
  notice: string;
  items: ControlTimingEntry[];
};
export const provinceIndex = provinceJson as {
  notice: string;
  items: ProvinceEntry[];
};
export const labelSample = sampleJson as SampleLabel;
