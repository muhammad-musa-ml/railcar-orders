export const LOCAL_ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
export const LOCAL_REGION = "us-east-2";
// DynamoDB Local accepts any credentials; these keep the SDK from looking for real ones.
export const LOCAL_CREDENTIALS = { accessKeyId: "local", secretAccessKey: "local" };
