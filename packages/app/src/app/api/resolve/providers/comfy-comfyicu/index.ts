import { ResolveRequest } from '@aitube/clapper-services'
import {
  ClapAssetSource,
  ClapSegmentCategory,
  ClapSegmentStatus,
  getClapAssetSourceType,
} from '@aitube/clap'
import { TimelineSegment } from '@aitube/timeline'
import { getWorkflowInputValues } from '../getWorkflowInputValues'
import {
  ComfyIcuApiRequestRunWorkflow,
  ComfyIcuApiResponseWorkflowStatus,
} from './types'

const POLL_INTERVAL_MS = 3000
const MAX_POLL_ATTEMPTS = 200

function getWorkflowForCategory(request: ResolveRequest) {
  switch (request.segment.category) {
    case ClapSegmentCategory.IMAGE:
      return request.settings.imageGenerationWorkflow
    case ClapSegmentCategory.VIDEO:
      return request.settings.videoGenerationWorkflow
    case ClapSegmentCategory.DIALOGUE:
      return request.settings.voiceGenerationWorkflow
    case ClapSegmentCategory.SOUND:
      return request.settings.soundGenerationWorkflow
    case ClapSegmentCategory.MUSIC:
      return request.settings.musicGenerationWorkflow
    default:
      throw new Error(
        `Clapper doesn't support ${request.segment.category} generation for provider "Comfy.icu"`
      )
  }
}

async function pollForCompletion(
  runId: string,
  workflowId: string,
  apiKey: string
): Promise<ComfyIcuApiResponseWorkflowStatus> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))

    const response = await fetch(
      `https://comfy.icu/api/v1/workflows/${workflowId}/runs/${runId}`,
      {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
      }
    )

    const status: ComfyIcuApiResponseWorkflowStatus = await response.json()

    if (status.status === 'completed' || status.status === 'success') {
      return status
    }

    if (status.status === 'error' || status.status === 'failed') {
      throw new Error(`ComfyICU workflow run failed: ${status.status}`)
    }
  }

  throw new Error(
    `ComfyICU workflow timed out after ${MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 1000}s`
  )
}

export async function resolveSegment(
  request: ResolveRequest
): Promise<TimelineSegment> {
  if (!request.settings.comfyIcuApiKey) {
    throw new Error(`Missing API key for "Comfy.icu"`)
  }

  const workflow = getWorkflowForCategory(request)
  const workflowId = workflow.id.split('://').pop() || ''

  if (!workflowId) {
    throw new Error(`The ComfyICU workflow ID is missing`)
  }

  const inputFields = workflow.inputFields || []

  // Find prompt field with fallback matching
  const promptFields = [
    inputFields.find((f) => f.id === 'prompt'),
    inputFields.find((f) => f.id.includes('prompt')),
    inputFields.find((f) => f.type === 'string'),
  ].filter((x) => typeof x !== 'undefined')

  const promptField = promptFields[0]

  // Inject prompt into the workflow data
  let workflowData = workflow.data
  if (promptField) {
    try {
      const parsedData = JSON.parse(workflowData)
      // Walk through nodes and inject prompt value
      for (const nodeId in parsedData) {
        const node = parsedData[nodeId]
        if (node.inputs && promptField.id in node.inputs) {
          node.inputs[promptField.id] = request.prompts.image.positive
        }
      }
      workflowData = JSON.stringify(parsedData)
    } catch {
      // If parsing fails, use original data
    }
  }

  const payload: ComfyIcuApiRequestRunWorkflow = {
    workflow_id: workflowId,
    prompt: workflowData,
    files: {},
  }

  const rawResponse = await fetch(
    `https://comfy.icu/api/v1/workflows/${workflowId}/runs`,
    {
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${request.settings.comfyIcuApiKey}`,
      },
      body: JSON.stringify(payload),
      method: 'POST',
    }
  )

  const submitResponse = await rawResponse.json()

  if (submitResponse.status === 'error') {
    throw new Error(submitResponse.message)
  }

  const runId = submitResponse.id
  if (!runId) {
    throw new Error('ComfyICU did not return a run ID')
  }

  // Poll until completion
  const completedRun = await pollForCompletion(
    runId,
    workflowId,
    request.settings.comfyIcuApiKey
  )

  const segment: TimelineSegment = { ...request.segment }

  if (!completedRun.output || completedRun.output.length === 0) {
    throw new Error('ComfyICU workflow completed but produced no output')
  }

  // Use the first output file URL
  const outputUrl = completedRun.output[0].url
  segment.assetUrl = outputUrl
  segment.assetSourceType = getClapAssetSourceType(outputUrl)

  return segment
}
