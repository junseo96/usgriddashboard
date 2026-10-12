import raw from '../data/project-status-reviews.json' with { type: 'json' };
import { validateProjectStatusReviews, type ProjectStatusReviewDataset } from './project-status-reviews.ts';
validateProjectStatusReviews(raw);
export const projectStatusReviews: ProjectStatusReviewDataset = raw;
