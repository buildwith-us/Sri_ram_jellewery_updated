import { MongoMemoryServer } from "mongodb-memory-server";

// One mongod for the whole run. Each test file connects to its own database
// on it (see tests/helpers/app.js), so files can run in parallel.
let mongod;

export async function setup(project) {
  mongod = await MongoMemoryServer.create();
  project.provide("mongoUri", mongod.getUri());
}

export async function teardown() {
  await mongod?.stop();
}
