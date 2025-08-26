import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import csv from 'csv-parser';
import { Readable } from 'stream';
import { logger } from '../logger.js';

const extractResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      content: z.string(),
      metadata: z.object({
        filename: z.string(),
        size: z.number(),
        type: z.string(),
        pages: z.number().optional(),
        rows: z.number().optional(),
      }),
    })
    .optional(),
  error: z.string().optional(),
});

type ExtractResponse = z.infer<typeof extractResponseSchema>;

export async function uploadRoutes(fastify: FastifyInstance) {
  // File content extraction endpoint
  fastify.post<{
    Reply: ExtractResponse;
  }>(
    '/api/extract-content',
    {
      schema: {
        response: {
          200: zodToJsonSchema(extractResponseSchema),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const data = await request.file();

        if (!data) {
          reply.code(400);
          return {
            success: false,
            error: 'No file uploaded',
          };
        }

        const filename = data.filename;
        const buffer = await data.toBuffer();
        const fileType = filename.split('.').pop()?.toLowerCase() || '';

        logger.info(
          {
            filename,
            size: buffer.length,
            type: fileType,
          },
          'Processing file upload'
        );

        let content = '';
        let metadata: any = {
          filename,
          size: buffer.length,
          type: fileType,
        };

        try {
          switch (fileType) {
            case 'pdf':
              // @ts-ignore - pdf-parse doesn't have TypeScript declarations
              const pdfParse = (await import('pdf-parse')).default;
              const pdfData = await pdfParse(buffer);
              content = pdfData.text;
              metadata.pages = pdfData.numpages;
              break;

            case 'csv':
              content = await parseCsv(buffer);
              const rows = content.split('\n').length - 1;
              metadata.rows = rows;
              break;

            case 'txt':
            case 'md':
              content = buffer.toString('utf-8');
              break;

            case 'docx':
              // For DOCX, we'll need mammoth or similar library
              // For now, fall back to text extraction
              content = buffer.toString('utf-8');
              logger.warn({ filename }, 'DOCX parsing not fully implemented, treating as text');
              break;

            default:
              // Try to parse as text
              content = buffer.toString('utf-8');
              logger.warn(
                { filename, type: fileType },
                'Unknown file type, attempting text extraction'
              );
          }

          // Validate content
          if (!content || content.trim().length === 0) {
            reply.code(400);
            return {
              success: false,
              error: 'No readable content found in file',
            };
          }

          // Clean up content
          content = cleanText(content);

          logger.info(
            {
              filename,
              contentLength: content.length,
              type: fileType,
            },
            'File content extracted successfully'
          );

          return {
            success: true,
            data: {
              content,
              metadata,
            },
          };
        } catch (parseError: any) {
          logger.error(
            {
              filename,
              type: fileType,
              error: parseError.message,
            },
            'Failed to parse file content'
          );

          reply.code(400);
          return {
            success: false,
            error: `Failed to parse ${fileType} file: ${parseError.message}`,
          };
        }
      } catch (error: any) {
        logger.error(
          {
            error: error.message,
          },
          'File upload processing failed'
        );

        reply.code(500);
        return {
          success: false,
          error: error.message || 'Internal server error',
        };
      }
    }
  );
}

// Helper function to parse CSV
function parseCsv(buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const results: any[] = [];
    const stream = Readable.from(buffer.toString());

    stream
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => {
        try {
          // Convert CSV rows to readable text
          const content = results
            .map((row, index) => {
              const rowText = Object.entries(row)
                .map(([key, value]) => `${key}: ${value}`)
                .join(', ');
              return `Row ${index + 1}: ${rowText}`;
            })
            .join('\n');

          resolve(content);
        } catch (error) {
          reject(error);
        }
      })
      .on('error', reject);
  });
}

// Helper function to clean text content
function cleanText(text: string): string {
  return text
    .replace(/\r\n/g, '\n') // Normalize line endings
    .replace(/\r/g, '\n') // Handle old Mac line endings
    .replace(/\n{3,}/g, '\n\n') // Reduce multiple newlines
    .replace(/[ \t]+/g, ' ') // Normalize spaces
    .trim();
}
