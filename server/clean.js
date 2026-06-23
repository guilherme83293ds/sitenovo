import pg from 'pg';
const pool = new pg.Pool({ 
  connectionString: 'postgresql://neondb_owner:npg_DyMQTi5nFsm0@ep-hidden-boat-ap4xi4f7-pooler.c-7.us-east-1.aws.neon.tech/neondb', 
  ssl: { rejectUnauthorized: false } 
});

async function clean() {
  console.log("Iniciando limpeza...");
  try {
    const res = await pool.query("DELETE FROM credentials WHERE url = 'https' OR url = 'http' OR email LIKE '//%'");
    console.log(`Sucesso! ${res.rowCount} registros bugados foram removidos.`);
  } catch (e) {
    console.error("Erro na limpeza:", e);
  } finally {
    process.exit(0);
  }
}

clean();
