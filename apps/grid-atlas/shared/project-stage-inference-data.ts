import raw from '../data/project-stage-inferences.json' with { type: 'json' };
import { validateProjectStageInferences, type ProjectStageInferenceDataset } from './project-stage-inference.ts';

validateProjectStageInferences(raw);
export const projectStageInferences: ProjectStageInferenceDataset = raw;
