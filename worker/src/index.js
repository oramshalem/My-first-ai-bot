import instructions from "../../prompts/character_v1.txt";
import testPage from "../public/test.html";
import logsPage from "../public/logs.html";
import { createApp } from "./app.js";

export default createApp({ instructions, testPage, logsPage });
