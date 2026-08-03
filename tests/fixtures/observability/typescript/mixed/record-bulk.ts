import { PotemkinConfigure, factoryName, simulation, type FactoryContext } from "potemkin/sdk";
import { bulkGlobal, recordBatchBoundary } from "../shared/recordDefinitions";

export class MixedRecordBatchFactory {
  @PotemkinConfigure(factoryName("mixed-record-batch"))
  static create(_context: FactoryContext) {
    return simulation().boundary(recordBatchBoundary()).global(bulkGlobal()).build();
  }
}
