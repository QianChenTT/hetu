import type { GrantRiskClassifier } from '../../../api/classes.ts'
import { classes } from './decide.ts'

// The grant risk classifier, answering from the table the plugins manager hands it and making no calls
export function createGrantRiskClassifier(): GrantRiskClassifier {
  return { classes }
}
