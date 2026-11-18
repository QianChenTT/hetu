import { definePlugin } from '@hetu/sdk'
import { createGrantRiskClassifier } from './grant-risk-classifier.ts'

// Answers from what it is handed and makes no calls, so it has nothing to start
export default definePlugin({ start() {} })

// The grant risk classifier slot's role the loader reads once the plugin is ready
export const grantRiskClassifier = createGrantRiskClassifier()
