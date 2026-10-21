import { getOrder, withErrors } from "../api/orders-api";
import { OrderStore } from "../store/orders";
import { apiEntry, documentClient, requireEnv } from "./runtime";

const orders = new OrderStore(documentClient(), requireEnv("TABLE_NAME"));

export const handler = apiEntry(withErrors(getOrder({ orders })));
