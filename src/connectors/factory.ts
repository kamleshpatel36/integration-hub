import { ConnectorType } from "@prisma/client";
import { BaseConnector, ConnectorConfig } from "./base";
import { NetSuiteConnector } from "./netsuite";
import { GenericRestConnector } from "./genericRest";

export function createConnector(type: ConnectorType, config: ConnectorConfig): BaseConnector {
  switch (type) {
    case "NETSUITE":
      return new NetSuiteConnector(config);
    case "SHOPIFY":
    case "SALESFORCE":
    case "GENERIC_REST":
      return new GenericRestConnector(config);
    default:
      throw new Error(`Unknown connector type: ${type}`);
  }
}
