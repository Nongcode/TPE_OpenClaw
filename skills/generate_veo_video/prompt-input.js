export function normalizePromptCandidateDescriptor(candidate) {
  return [
    candidate?.text || "",
    candidate?.placeholder || "",
    candidate?.ariaLabel || "",
  ]
    .join(" ")
    .toLowerCase();
}

export function isSearchLikePromptCandidate(candidate) {
  const descriptor = normalizePromptCandidateDescriptor(candidate);
  return descriptor.includes("tìm kiếm") || descriptor.includes("tim kiem") || descriptor.includes("search");
}

export function pickBestPromptCandidate(candidates) {
  return [...(Array.isArray(candidates) ? candidates : [])]
    .filter((candidate) => candidate && !isSearchLikePromptCandidate(candidate))
    .sort((left, right) => {
      const leftY = Number.isFinite(left?.y) ? left.y : 0;
      const rightY = Number.isFinite(right?.y) ? right.y : 0;
      return rightY - leftY;
    })[0] || null;
}
