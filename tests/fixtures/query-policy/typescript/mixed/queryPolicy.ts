import {
  PotemkinConfigure,
  boundary,
  boundaryName,
  contractPath,
  factoryName,
  pathParameter,
  pathSegment,
  simulation,
} from "potemkin/sdk";

const orderById = boundary(
  boundaryName("OrderById"),
  contractPath(pathSegment("orders"), pathParameter("id")),
)
  .fallbackOverride(true)
  .identity({ key: { from: "path", name: "id" } })
  .query({ fallback: () => ({ code: "ORDER_NOT_FOUND" }) });

export class MixedQueryPolicyFactory {
  @PotemkinConfigure(factoryName("query-policy-mixed"))
  static create() {
    return simulation().boundary(orderById).build();
  }
}
