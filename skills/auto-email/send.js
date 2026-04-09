const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const toEmail = String(args[0] || "").trim();
const subject = String(args[1] || "").trim();
const rawBody = args[2] || "";
const body = rawBody.replace(/\\n/g, "\n");
const attachmentPathsString = args[3];

function loadDotEnvFile() {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function readEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function buildTransportConfig() {
  const user = readEnv("AUTO_EMAIL_SMTP_USER");
  const pass = readEnv("AUTO_EMAIL_SMTP_PASS");
  const from = readEnv("AUTO_EMAIL_FROM") || user;
  const service = readEnv("AUTO_EMAIL_SMTP_SERVICE") || "gmail";
  const host = readEnv("AUTO_EMAIL_SMTP_HOST");
  const portRaw = readEnv("AUTO_EMAIL_SMTP_PORT");
  const secureRaw = readEnv("AUTO_EMAIL_SMTP_SECURE");

  if (!user || !pass) {
    throw new Error(
      "Missing SMTP credentials. Set AUTO_EMAIL_SMTP_USER and AUTO_EMAIL_SMTP_PASS.",
    );
  }

  const port = portRaw ? Number.parseInt(portRaw, 10) : undefined;
  if (portRaw && Number.isNaN(port)) {
    throw new Error("AUTO_EMAIL_SMTP_PORT must be a valid integer.");
  }

  const secure =
    secureRaw === ""
      ? undefined
      : ["1", "true", "yes"].includes(secureRaw.toLowerCase());

  const transport = host
    ? {
        host,
        ...(port ? { port } : {}),
        ...(secure !== undefined ? { secure } : {}),
        auth: { user, pass },
      }
    : {
        service,
        auth: { user, pass },
      };

  return { transport, from };
}

function buildMailOptions(fromAddress) {
  if (!toEmail) {
    throw new Error("Missing recipient email.");
  }
  if (!subject) {
    throw new Error("Missing email subject.");
  }

  const isBulkEmail = toEmail.includes(",");
  const mailOptions = {
    from: fromAddress,
    to: isBulkEmail ? fromAddress : toEmail,
    bcc: isBulkEmail ? toEmail : "",
    subject,
    text: body,
  };

  if (attachmentPathsString && attachmentPathsString.trim() !== "") {
    const pathsArray = attachmentPathsString.split(",");
    mailOptions.attachments = [];

    for (const filePath of pathsArray) {
      const cleanPath = filePath.trim();
      if (!cleanPath) {
        continue;
      }
      if (fs.existsSync(cleanPath)) {
        mailOptions.attachments.push({ path: cleanPath });
        console.log(`[He thong] Da gom thanh cong file: ${cleanPath}`);
      } else {
        console.log(`[Canh bao] Khong tim thay file: ${cleanPath}. He thong se bo qua file nay.`);
      }
    }

    if (mailOptions.attachments.length === 0) {
      delete mailOptions.attachments;
      console.log("[Canh bao] Toan bo file dinh kem deu bi loi duong dan. Email se gui chay.");
    }
  }

  return mailOptions;
}

function printSendError(error) {
  const message = error && error.message ? error.message : String(error);
  const response = error && typeof error.response === "string" ? error.response : "";
  const code = error && error.code ? ` (${error.code})` : "";

  console.log(`LOI${code}: ${message}`);
  if (response && response !== message) {
    console.log(`SMTP_RESPONSE: ${response}`);
  }
  if (/535|username and password not accepted/i.test(`${message}\n${response}`)) {
    console.log(
      "GOI_Y: SMTP dang tu choi dang nhap. Kiem tra lai AUTO_EMAIL_SMTP_USER, AUTO_EMAIL_SMTP_PASS, va neu dung Gmail thi hay dung App Password hop le.",
    );
  }
}

async function main() {
  loadDotEnvFile();
  const { transport, from } = buildTransportConfig();
  const transporter = nodemailer.createTransport(transport);
  const mailOptions = buildMailOptions(from);

  try {
    await transporter.sendMail(mailOptions);
    const soLuongFile = mailOptions.attachments ? mailOptions.attachments.length : 0;
    console.log(
      `THANH CONG: Email da duoc gui toi ${toEmail} ` +
        (soLuongFile > 0 ? `CUNG VOI ${soLuongFile} FILE DINH KEM.` : "(Khong co file dinh kem)."),
    );
  } catch (error) {
    printSendError(error);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  printSendError(error);
  process.exitCode = 1;
});
