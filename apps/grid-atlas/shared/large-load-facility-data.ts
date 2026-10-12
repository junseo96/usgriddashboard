import raw from '../data/large-load-facilities.json' with { type: 'json' };
import { validateLargeLoadFacilities, type FacilityDataset } from './large-load-facilities.ts';

validateLargeLoadFacilities(raw);
export const largeLoadFacilities: FacilityDataset = raw;
