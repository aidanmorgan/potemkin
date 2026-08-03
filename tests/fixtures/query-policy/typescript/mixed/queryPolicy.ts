import { PotemkinConfigure, boundary, simulation } from "potemkin/sdk";

const orderById = boundary("OrderById", "/orders/{id}")
  .fallbackOverride(true)
  .identity({ key: { from: "path", name: "id" } })
  .query({ fallback: () => ({ code: "ORDER_NOT_FOUND" }) });

export class MixedQueryPolicyFactory {
  @PotemkinConfigure("query-policy-mixed")
  static create() {
    return simulation().boundary(orderById).build();
  }
}
