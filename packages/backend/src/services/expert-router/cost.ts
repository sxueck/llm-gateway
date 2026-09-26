import { modelDb } from "../../db/index.js";
import type { CostInput, ExpertTarget } from "../../types/expert-routing.js";

/** 按 expert 引用的模型行取 token 单价；取不到时返回 undefined（视作最贵）。 */
export async function resolveExpertCost(
  expert: ExpertTarget,
): Promise<CostInput | undefined> {
  try {
    let attributes: unknown;
    if (expert.type === "virtual") {
      if (!expert.model_id) return undefined;
      const model = await modelDb.getById(expert.model_id);
      attributes = model?.model_attributes;
    } else {
      if (!expert.provider_id || !expert.model) return undefined;
      const models = await modelDb.getByProviderId(expert.provider_id);
      const match = (models as any[] | undefined)?.find(
        (candidate) =>
          candidate.is_virtual !== 1 &&
          (candidate.model_identifier === expert.model || candidate.name === expert.model),
      );
      attributes = match?.model_attributes;
    }
    if (typeof attributes !== "string" || !attributes) return undefined;
    const parsed = JSON.parse(attributes) as CostInput;
    return {
      input_cost_per_token: Number(parsed?.input_cost_per_token),
      output_cost_per_token: Number(parsed?.output_cost_per_token),
    };
  } catch {
    return undefined;
  }
}
