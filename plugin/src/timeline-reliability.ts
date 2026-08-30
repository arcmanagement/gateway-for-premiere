import type { TimelineSnapshot } from "../../src/shared/protocol";

export function timelineRevisionReliability(input: {
  hasOpaqueTransitions: boolean;
  hasIncompleteComponents: boolean;
  hasOpaqueCaptions: boolean;
}): TimelineSnapshot["revisionReliability"] {
  const incompleteCount = [
    input.hasOpaqueTransitions,
    input.hasIncompleteComponents,
    input.hasOpaqueCaptions,
  ].filter(Boolean).length;
  if (incompleteCount > 1) return "multiple-incomplete";
  if (input.hasOpaqueTransitions) return "opaque-transitions";
  if (input.hasIncompleteComponents) return "incomplete-components";
  if (input.hasOpaqueCaptions) return "opaque-captions";
  return "complete";
}
