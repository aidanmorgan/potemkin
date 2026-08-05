import { PotemkinConfigure, factoryName, simulation, type FactoryContext } from 'potemkin/sdk';
import {
  auditBoundary,
  bulkGlobal,
  receiptBoundary,
  recordBatchBoundary,
  recordByIdBoundary,
} from '../shared/recordDefinitions';

export class RecordBatchFactory {
  @PotemkinConfigure(factoryName('record-batch'))
  static create(_context: FactoryContext) {
    return simulation()
      .boundary(recordBatchBoundary())
      .boundary(recordByIdBoundary())
      .boundary(receiptBoundary())
      .boundary(auditBoundary())
      .global(bulkGlobal())
      .build();
  }
}
